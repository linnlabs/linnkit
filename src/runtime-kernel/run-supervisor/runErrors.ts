export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export class RunAlreadyRegisteredError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`RunSupervisor: run ${runId} is already registered`);
    this.name = 'RunAlreadyRegisteredError';
    this.runId = runId;
  }
}
