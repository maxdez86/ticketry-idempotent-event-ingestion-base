import type { FastifyInstance } from "fastify";

import { listAudit } from "@ticketry/core";

import { pageFromQuery } from "../lib/http.js";

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get("/audit", async (request) => {
    const page = pageFromQuery(request.query as Record<string, unknown>);
    return {
      entries: await listAudit(request.db, request.principal.tenantId, page),
      limit: page.limit,
      offset: page.offset
    };
  });
}
