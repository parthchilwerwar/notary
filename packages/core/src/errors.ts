/** Errors shared by the CLI and the modules it drives (kept here so library code needn't import cli.ts). */

export class NotImplementedError extends Error {
  constructor(command: string, phase: string) {
    super(`notary ${command}: not implemented yet (lands in ${phase}, see PLAN.md)`);
    this.name = "NotImplementedError";
  }
}
