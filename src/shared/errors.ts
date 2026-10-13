export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 500) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) {
    super("INVALID_CONFIGURATION", message, 500);
    this.name = "ConfigurationError";
  }
}
