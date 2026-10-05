// Shared error shape for the management API (S01 §8): HTTP status + stable
// machine-readable code. Services throw it; lib/control/http.mjs renders it.

export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} code stable machine-readable code (e.g. "forbidden").
   * @param {string} message human-readable message.
   * @param {unknown} [details] optional structured details.
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
