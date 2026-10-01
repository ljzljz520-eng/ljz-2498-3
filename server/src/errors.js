'use strict';
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
const notFound = (msg) => new HttpError(404, 'not_found', msg);
const conflict = (msg, details) => new HttpError(409, 'conflict', msg, details);
const unprocessable = (msg, details) => new HttpError(422, 'unprocessable_entity', msg, details);
module.exports = { HttpError, badRequest, notFound, conflict, unprocessable };
