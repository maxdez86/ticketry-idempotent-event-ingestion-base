export class NotFoundError extends Error {
  constructor(
    readonly resource: string,
    readonly id: string
  ) {
    super(`${resource} ${id} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(readonly current: string, readonly next: string) {
    super(`cannot transition ticket from ${current} to ${next}`);
    this.name = "InvalidTransitionError";
  }
}
