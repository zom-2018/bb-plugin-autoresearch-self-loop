#!/usr/bin/env bash
set -euo pipefail

# autoresearch-finalize — creates independent branches from an autoresearch session
#
# Usage: finalize.sh <groups.json>
#
# groups.json format:
# {
#   "base": "<full merge-base commit hash>",
#   "trunk": "main",
#   "final_tree": "<full HEAD hash of autoresearch branch>",
#   "goal": "short-slug",
#   "groups": [
#     {
#       "title": "Switch to forks pool",
#       "body": "Use forks instead of threads...\n\nExperiments: #3, #5\nMetric: 42.3s → 38.1s (-9.9%)",
#       "last_commit": "<full commit hash>",
#       "slug": "forks-pool"
#     }
#   ]
# }

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

DATA_DIR=""
ORIG_BRANCH=""
TRUNK=""
BASE=""
FINAL_TREE=""
GOAL=""
GROUP_COUNT=""
STASHED=false
# Set once a group checkout has begun: rollback then discards that group's partial work.
WORK_STARTED=false
# A group branch that exists but has no commit yet; rollback deletes it too.
PENDING_BRANCH=""
CREATED_BRANCHES=()
declare -a GROUP_BRANCH

warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
info() { echo -e "${GREEN}$1${NC}"; }
cleanup_data() { if [ -d "${DATA_DIR:-}" ]; then rm -rf "$DATA_DIR"; fi; }
fail() { cleanup_data; echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

# Session files are the checkout root's .auto/ folder and the legacy flat files pi wrote there. The legacy
# names must match LEGACY_SESSION_PATHS in lib/paths.ts. git prints paths from the repository top, so
# ROOT_PREFIX (set in main) is the checkout's offset in it. A nested .auto/ folder belongs to the project.
LEGACY_SESSION_NAMES=(autoresearch.jsonl autoresearch.md autoresearch.ideas.md autoresearch.checks.sh autoresearch.sh autoresearch.config.json autoresearch.run.log autoresearch.hooks)

is_session_file() {
  local name
  case "/$1" in
    "/${ROOT_PREFIX}.auto"|"/${ROOT_PREFIX}.auto/"*) return 0;;
  esac
  for name in "${LEGACY_SESSION_NAMES[@]}"; do
    case "/$1" in
      "/${ROOT_PREFIX}${name}"|"/${ROOT_PREFIX}${name}/"*) return 0;;
    esac
  done
  return 1
}

# ---------------------------------------------------------------------------
# Parse
# ---------------------------------------------------------------------------

parse_groups() {
  local groups_file="$1"
  [ -f "$groups_file" ] || fail "$groups_file not found"

  # Serialize JSON fields into flat files so bash can consume them without jq.
  # Node is already a dependency (used by the extension), so no new dep required.
  # The paths go in through the environment, so no path can end the JS string.
  DATA_DIR=$(mktemp -d)
  GROUPS_FILE="$groups_file" OUT_DIR="$DATA_DIR" node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.env.GROUPS_FILE, 'utf-8'));
const outDir = process.env.OUT_DIR;
fs.writeFileSync(outDir + '/base', config.base);
fs.writeFileSync(outDir + '/trunk', config.trunk || 'main');
fs.writeFileSync(outDir + '/final_tree', config.final_tree);
fs.writeFileSync(outDir + '/goal', config.goal);
fs.writeFileSync(outDir + '/count', String(config.groups.length));
config.groups.forEach((group, idx) => {
  fs.writeFileSync(outDir + '/' + idx + '.title', group.title);
  fs.writeFileSync(outDir + '/' + idx + '.body', group.body);
  fs.writeFileSync(outDir + '/' + idx + '.last_commit', group.last_commit);
  fs.writeFileSync(outDir + '/' + idx + '.slug', group.slug);
});
" || fail "Failed to parse $groups_file — check JSON syntax."

  BASE=$(cat "$DATA_DIR/base")
  TRUNK=$(cat "$DATA_DIR/trunk")
  FINAL_TREE=$(cat "$DATA_DIR/final_tree")
  GOAL=$(cat "$DATA_DIR/goal")
  GROUP_COUNT=$(cat "$DATA_DIR/count")
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

assert_on_feature_branch() {
  ORIG_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  [ -n "$ORIG_BRANCH" ] || fail "Detached HEAD — switch to the autoresearch branch first."
  [ "$ORIG_BRANCH" != "$TRUNK" ] || fail "On trunk ($TRUNK) — switch to the autoresearch branch first."
}

assert_commits_exist() {
  git cat-file -e "$BASE^{commit}" 2>/dev/null || fail "Base commit $BASE not found."
  git cat-file -e "$FINAL_TREE^{commit}" 2>/dev/null || fail "Final tree commit $FINAL_TREE not found."
}

# BASE must be where the session branched off trunk. The group branches start from BASE, so a BASE that is
# not the fork point puts every trunk commit between the two into each group. Either the remote or the local
# trunk may be the one that matches, so the check passes when the merge-base equals BASE for either.
assert_base_is_trunk_merge_base() {
  local base_full ref expected
  local refs=()
  base_full=$(git rev-parse --verify --quiet "$BASE^{commit}") || fail "Base commit $BASE not found."
  for ref in "origin/$TRUNK" "$TRUNK"; do
    if git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
      refs+=("$ref")
    fi
  done
  [ ${#refs[@]} -gt 0 ] || fail "Neither origin/$TRUNK nor $TRUNK exists, so the base cannot be checked against trunk."
  for ref in "${refs[@]}"; do
    expected=$(git merge-base "$FINAL_TREE" "$ref" 2>/dev/null || true)
    if [ "$expected" = "$base_full" ]; then return 0; fi
  done
  fail "Base $BASE is not where the session branched off $TRUNK. Use: git merge-base $FINAL_TREE $TRUNK"
}

# Git cannot hold the branch 'a/b' next to 'a/b/c', so a branch named like a prefix of
# the group branches (for example the session branch, when its name equals the goal) blocks them.
assert_group_namespace_free() {
  local prefix
  for prefix in "autoresearch" "autoresearch/${GOAL}"; do
    if git show-ref --verify --quiet "refs/heads/$prefix"; then
      fail "Branch '$prefix' is in the way of the group branches. Use a different goal slug."
    fi
  done
}

collect_group_files() {
  local group_index="$1" prev_commit="$2"
  local last_commit

  last_commit=$(cat "$DATA_DIR/$group_index.last_commit")
  git cat-file -e "$last_commit^{commit}" 2>/dev/null \
    || fail "Group $((group_index+1)) last_commit $last_commit not found. Use full hashes (git rev-parse <short>)."

  # NUL-delimited (-z) via process substitution to handle spaces/globs in filenames.
  # --no-renames: a rename must list both paths, or the old one is never removed.
  local changed_file
  : > "$DATA_DIR/$group_index.files"
  while IFS= read -r -d '' changed_file; do
    [ -n "$changed_file" ] || continue
    # printf, not echo: echo would read a name such as -e or -n as its own option and drop it.
    # NUL ends each record, so a name holding a newline stays one record.
    is_session_file "$changed_file" || printf '%s\0' "$changed_file" >> "$DATA_DIR/$group_index.files"
  done < <(git diff --no-renames --name-only -z "$prev_commit" "$last_commit")
}

assert_no_overlapping_files() {
  local new_files_path="$1" seen_files_path="$2"
  [ -s "$new_files_path" ] || return 0
  [ -s "$seen_files_path" ] || return 0
  local candidate seen
  while IFS= read -r -d '' candidate; do
    # Compared in bash: grep reads a newline in a pattern as two patterns, and a name such as -dash.txt as an option.
    while IFS= read -r -d '' seen; do
      if [ "$seen" = "$candidate" ]; then
        fail "File '$candidate' appears in multiple groups. Merge the overlapping groups and retry."
      fi
    done < "$seen_files_path"
  done < "$new_files_path"
}

assert_branch_available() {
  local branch_name="$1"
  if git rev-parse --verify "$branch_name" >/dev/null 2>&1; then
    fail "Branch '$branch_name' already exists. Delete it first or use a different goal slug."
  fi
}

preflight() {
  echo ""
  info "═══ Preflight ═══"
  echo ""

  assert_on_feature_branch
  assert_commits_exist
  assert_base_is_trunk_merge_base
  assert_group_namespace_free

  local prev_commit="$BASE"
  local all_seen_path="$DATA_DIR/all_seen_files"
  : > "$all_seen_path"

  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    collect_group_files "$i" "$prev_commit"
    assert_no_overlapping_files "$DATA_DIR/$i.files" "$all_seen_path"
    cat "$DATA_DIR/$i.files" >> "$all_seen_path"

    local group_number branch_name
    group_number=$(printf "%02d" $((i + 1)))
    branch_name="autoresearch/${GOAL}/${group_number}-$(cat "$DATA_DIR/$i.slug")"
    assert_branch_available "$branch_name"
    GROUP_BRANCH[$i]=""

    prev_commit=$(cat "$DATA_DIR/$i.last_commit")
  done

  assert_branch_available "autoresearch/${GOAL}/verify-tmp"

  info "Preflight passed."
  echo "  Branch:     $ORIG_BRANCH"
  echo "  Base:       ${BASE:0:12}"
  echo "  Groups:     $GROUP_COUNT"
}

# ---------------------------------------------------------------------------
# Create branches
# ---------------------------------------------------------------------------

# A group's file: take its content from the group's commit, or remove it when that
# commit deleted it, since `git checkout` cannot restore a path the commit does not have.
apply_file() {
  local commit="$1" path="$2"
  # :(literal) keeps glob characters in a name from matching its neighbours, and :(top) reads the path from the
  # repository root, as git diff prints it, even when the checkout is a folder inside a larger repository.
  local spec=":(top,literal)$path"
  # A blob check, not -e: a path that became a directory in the commit is a tree, and checkout would take the whole directory.
  if [ "$(git cat-file -t "$commit:$path" 2>/dev/null)" = "blob" ]; then
    git checkout --quiet "$commit" -- "$spec"
  else
    git rm --quiet --ignore-unmatch -- "$spec"
  fi
}

rollback_on_failure() {
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then return; fi

  echo ""
  echo -e "${RED}FAILED — rolling back...${NC}"
  # The user's own changes are in the stash, so what is left is this script's partial work.
  if [ "$WORK_STARTED" = true ]; then
    git reset --quiet --hard 2>/dev/null || true
  fi
  local back=false
  if [ -n "${ORIG_BRANCH:-}" ] && git checkout --quiet "$ORIG_BRANCH" 2>/dev/null; then back=true; fi
  # Delete after leaving the branches: git will not delete the one that is checked out.
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"} ${PENDING_BRANCH:+"$PENDING_BRANCH"}; do
    git branch -D "$branch" >/dev/null 2>&1 || true
  done
  if [ "$back" = true ] && [ "$STASHED" = true ]; then
    git stash pop --index --quiet 2>/dev/null \
      || echo -e "${YELLOW}⚠ Could not restore stashed changes. Run 'git stash list' to recover.${NC}"
  fi
  cleanup_data
  if [ "$back" = true ]; then
    echo -e "${RED}Rolled back to '$ORIG_BRANCH'. No branches left behind.${NC}"
  else
    echo -e "${RED}Could not return to '$ORIG_BRANCH'. Check 'git status' and 'git stash list' before anything else.${NC}"
  fi
}

stash_if_dirty() {
  if ! git diff --quiet 2>/dev/null \
    || ! git diff --cached --quiet 2>/dev/null \
    || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
    warn "Stashing uncommitted changes..."
    git stash push -u --quiet -m "autoresearch-finalize: uncommitted work"
    STASHED=true
  fi
}

create_group_branch() {
  local i="$1"
  local title body last_commit slug files group_number branch_name

  title=$(cat "$DATA_DIR/$i.title")
  body=$(cat "$DATA_DIR/$i.body")
  last_commit=$(cat "$DATA_DIR/$i.last_commit")
  slug=$(cat "$DATA_DIR/$i.slug")
  local files_path="$DATA_DIR/$i.files"

  group_number=$(printf "%02d" $((i + 1)))
  branch_name="autoresearch/${GOAL}/${group_number}-${slug}"

  info "[$group_number/$GROUP_COUNT] $title"

  if [ ! -s "$files_path" ]; then
    warn "No files changed — skipping this group"
    GROUP_BRANCH[$i]="skipped"
    return
  fi

  # Start from merge-base (not the previous group) so each branch is
  # independently mergeable — reviewers can land them in any order.
  WORK_STARTED=true
  git checkout --quiet --detach "$BASE"
  git checkout --quiet -b "$branch_name"
  # Set only once the branch is ours: rollback deletes PENDING_BRANCH, so a name that was already taken must never land here.
  PENDING_BRANCH="$branch_name"

  while IFS= read -r -d '' changed_file; do
    [ -n "$changed_file" ] || continue
    apply_file "$last_commit" "$changed_file"
  done < "$files_path"
  git commit -m "$title" -m "$body"

  CREATED_BRANCHES+=("$branch_name")
  PENDING_BRANCH=""
  GROUP_BRANCH[$i]="$branch_name"
  echo "  Branch: $branch_name"
  echo "  Files: $(tr '\0' ' ' < "$files_path")"
  echo ""
}

create_branches() {
  echo ""
  info "═══ Creating branches ═══"
  echo ""

  trap rollback_on_failure EXIT
  stash_if_dirty

  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    create_group_branch "$i"
  done

  info "Created ${#CREATED_BRANCHES[@]} branches (all from merge-base, independent):"
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do echo "  $branch"; done

  # Disarm rollback — creation succeeded. Verify failures intentionally leave
  # branches intact so the user can inspect and fix manually.
  trap - EXIT
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

# Builds the union of the groups on a temporary branch. It runs in an `||` list, where set -e does not apply,
# so each step checks its own result.
build_union_branch() {
  local verify_branch="$1" i last_commit changed_file
  git checkout --quiet --detach "$BASE" || return 1
  git checkout --quiet -b "$verify_branch" || return 1

  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    last_commit=$(cat "$DATA_DIR/$i.last_commit")
    while IFS= read -r -d '' changed_file; do
      [ -n "$changed_file" ] || continue
      apply_file "$last_commit" "$changed_file" || return 1
    done < "$DATA_DIR/$i.files"
  done
  # --allow-empty: when all groups cover all files, the checkout leaves
  # nothing staged — the diff against FINAL_TREE is what matters, not this commit.
  git commit --allow-empty -m "verify: union of all groups" --quiet || return 1
}

verify_union_matches_original() {
  local verify_branch="autoresearch/${GOAL}/verify-tmp" built=true
  local non_session_diff="" changed_file

  build_union_branch "$verify_branch" || built=false

  if [ "$built" = true ]; then
    while IFS= read -r -d '' changed_file; do
      is_session_file "$changed_file" || non_session_diff="$non_session_diff $changed_file"
    done < <(git diff --no-renames --name-only -z HEAD "$FINAL_TREE" 2>/dev/null)
  else
    # Only this script's partial work is on the verify branch: the user's changes are stashed, so this reset cannot reach them.
    git reset --quiet --hard 2>/dev/null || true
  fi

  # Back on the session branch, and the verify branch gone, whether or not the union was built.
  git checkout "$ORIG_BRANCH" --quiet 2>/dev/null || true
  git branch -D "$verify_branch" 2>/dev/null || true

  if [ "$built" = false ]; then
    echo -e "${RED}✗ Could not build the union of the groups on a temporary branch.${NC}"
    return 1
  fi

  if [ -n "$non_session_diff" ]; then
    echo -e "${RED}✗ Union of groups differs from autoresearch branch!${NC}"
    echo "  Files:$non_session_diff"
    return 1
  fi

  echo -e "${GREEN}✓ Union of all groups matches original autoresearch branch.${NC}"
  return 0
}

verify_no_session_artifacts() {
  local clean=true
  local branch changed_file
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do
    while IFS= read -r -d '' changed_file; do
      if is_session_file "$changed_file"; then
        echo -e "${RED}✗ Session artifact '$changed_file' in branch $branch!${NC}"
        clean=false
      fi
    done < <(git diff-tree --no-commit-id --name-only -r -z "$(git rev-parse "$branch")" 2>/dev/null)
  done

  if [ "$clean" = true ]; then
    echo -e "${GREEN}✓ No session artifacts in any branch.${NC}"
    return 0
  fi
  return 1
}

verify_no_empty_commits() {
  local errors=0
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do
    local commit diff
    commit=$(git rev-parse "$branch" 2>/dev/null)
    diff=$(git diff-tree --no-commit-id --name-only -r "$commit" 2>/dev/null || echo "")
    if [ -z "$diff" ]; then
      echo -e "${RED}✗ Empty commit in $branch${NC}"
      errors=$((errors + 1))
    fi
  done
  return $errors
}

warn_missing_metric_data() {
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do
    local msg short
    msg=$(git log -1 --format="%B" "$branch" 2>/dev/null || echo "")
    if ! echo "$msg" | grep -qiE '(metric|→|->|%\))'; then
      short=$(git log -1 --oneline "$branch" 2>/dev/null | head -c 80)
      warn "Commit $short — no metric data in message"
    fi
  done
}

verify_branches() {
  echo ""
  info "═══ Verifying ═══"
  echo ""

  local errors=0

  verify_union_matches_original || errors=$((errors + 1))
  verify_no_session_artifacts || errors=$((errors + 1))
  verify_no_empty_commits || errors=$((errors + $?))
  warn_missing_metric_data

  echo ""
  if [ $errors -gt 0 ]; then
    echo -e "${RED}Verification failed with $errors error(s).${NC}"
    echo -e "${RED}Branches are intact — inspect and fix manually, or delete and retry.${NC}"
    echo "  Branches: ${CREATED_BRANCHES[*]+"${CREATED_BRANCHES[*]}"}"
    echo "  You are on: $(git branch --show-current 2>/dev/null || echo 'detached')"
    return 1
  fi
  info "✓ All checks passed."
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

# Puts the user's uncommitted work back on the original branch. Runs after verify, on
# success and on failure, since both leave the checkout on the original branch.
restore_stash() {
  [ "$STASHED" = true ] || return 0
  # Popping onto another branch would apply the user's work to the wrong tree, so leave it in the stash.
  if [ "$(git branch --show-current 2>/dev/null)" != "$ORIG_BRANCH" ]; then
    warn "Not on '$ORIG_BRANCH', so your stashed changes stay in the stash. Run 'git stash list' to recover."
    return 0
  fi
  if git stash pop --index --quiet; then
    STASHED=false
    info "Restored your uncommitted changes."
  else
    warn "Could not restore stashed changes. Run 'git stash list' to recover."
  fi
}

print_summary() {
  echo ""
  info "═══ Summary ═══"
  echo ""

  echo "Goal: $GOAL"
  echo "Base: ${BASE:0:12}"
  echo "Source branch: $ORIG_BRANCH"
  echo ""

  echo "Branches:"
  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    local title body branch group_number
    title=$(cat "$DATA_DIR/$i.title")
    body=$(cat "$DATA_DIR/$i.body")
    branch="${GROUP_BRANCH[$i]:-skipped}"
    group_number=$(printf "%02d" $((i + 1)))
    echo ""
    echo "  $group_number. $title"
    echo "     Branch: $branch"
    echo "     Files: $(tr '\0' ' ' < "$DATA_DIR/$i.files")"
    echo ""
    echo "$body" | sed 's/^/     /'
  done

  echo ""
  echo "Cleanup — after merging, delete the autoresearch branch and session files:"
  echo ""
  echo "  git branch -D $ORIG_BRANCH"
  echo "  rm -r .auto    # session folder (current layout)"
  echo "  rm -f autoresearch.jsonl autoresearch.sh autoresearch.md autoresearch.ideas.md    # legacy flat files, if any"

  local ideas_file=""
  if [ -f ".auto/ideas.md" ]; then
    ideas_file=".auto/ideas.md"
  elif [ -f "autoresearch.ideas.md" ]; then
    ideas_file="autoresearch.ideas.md"
  fi
  if [ -n "$ideas_file" ]; then
    echo ""
    echo "Ideas backlog (from $ideas_file):"
    echo ""
    sed 's/^/  /' "$ideas_file"
  fi

  echo ""
  if [ "$STASHED" = true ]; then
    warn "Changes were stashed. Run 'git stash pop' to restore or 'git stash drop' to discard."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  if [ $# -lt 1 ]; then
    echo "Usage: $0 <groups.json>"
    exit 1
  fi

  # The checkout's offset in the repository, for is_session_file.
  ROOT_PREFIX=$(git rev-parse --show-prefix)
  parse_groups "$1"
  preflight
  create_branches
  local verified=true
  verify_branches || verified=false
  restore_stash
  if [ "$verified" = false ]; then
    cleanup_data
    exit 1
  fi
  print_summary
  cleanup_data
}

main "$@"
