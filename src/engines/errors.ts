// Shared engine error types so the worker can distinguish a real failure
// (log + dequeue) from a deliberate hard-pause abort (requeue).

export class EngineError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public detail?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof AbortError || (err instanceof Error && err.name === "AbortError");
}
