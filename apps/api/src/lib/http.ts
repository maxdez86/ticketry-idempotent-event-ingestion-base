import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeAny, z } from "zod";

import { ConflictError, InvalidFiltersError, InvalidTransitionError, NotFoundError, ValidationError } from "@ticketry/core";
import type { Page } from "@ticketry/core";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function unauthorized(message = "invalid or missing API key"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message = "forbidden"): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof NotFoundError) {
    return new HttpError(404, "not_found", error.message);
  }
  if (error instanceof ConflictError) {
    return new HttpError(409, "conflict", error.message);
  }
  if (error instanceof InvalidTransitionError) {
    return new HttpError(400, "invalid_transition", error.message);
  }
  if (error instanceof ValidationError || error instanceof InvalidFiltersError) {
    return new HttpError(400, "bad_request", error.message);
  }
  return new HttpError(500, "internal_error", "internal error");
}

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body");
  }
  return result.data;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, query: unknown): z.output<S> {
  const result = schema.safeParse(query ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(issue ? `${issue.path.join(".") || "query"}: ${issue.message}` : "invalid query");
  }
  return result.data;
}

const MAX_LIMIT = 100;

export function pageFromQuery(query: Record<string, unknown>): Page {
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw badRequest("offset must be a non-negative integer");
  }
  return { limit, offset };
}

export function paramId(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, string | undefined>;
  const value = params[name];
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw badRequest(`${name} must be a UUID`);
  }
  return value;
}

export function sendError(reply: FastifyReply, error: HttpError): FastifyReply {
  return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
}
