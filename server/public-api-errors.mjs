export class PublicApiError extends Error {
  constructor(statusCode, message, code = "REQUEST_FAILED") {
    super(message);
    this.name = "PublicApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function publicApiError(statusCode, message, code) {
  return new PublicApiError(statusCode, message, code);
}
