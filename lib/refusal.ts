/**
 * An expected, user-facing refusal (wrong state, missing file, guard tripped).
 * Tools, CLI commands, and RPC methods turn it into a readable reply; anything
 * else is a bug and surfaces as a plugin error.
 */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}
