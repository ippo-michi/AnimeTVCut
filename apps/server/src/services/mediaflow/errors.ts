export class MediaFlowError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MediaFlowConfigurationError extends MediaFlowError {}

export class MediaFlowNotConfiguredError extends MediaFlowError {
  public constructor() {
    super("MediaFlow is not configured.");
  }
}

export class MediaFlowUnavailableError extends MediaFlowError {
  public constructor(message = "MediaFlow is unavailable.") {
    super(message);
  }
}

export class MediaFlowAuthenticationError extends MediaFlowError {
  public constructor() {
    super("MediaFlow authentication failed.");
  }
}

export class MediaFlowInvalidResponseError extends MediaFlowError {
  public constructor(message = "MediaFlow returned an invalid response.") {
    super(message);
  }
}

export class MediaFlowSourceError extends MediaFlowError {}
