import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  listTickets,
  parseTicketFilters
} from "@ticketry/core";

import { pageFromQuery, paramId, parseBody } from "../lib/http.js";
import { requireWrite } from "../plugins/auth.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  filters: z.record(z.unknown()).default({})
});

export function registerViewRoutes(app: FastifyInstance): void {
  app.get("/views", async (request) => {
    return { views: await listSavedViews(request.db, request.principal.tenantId) };
  });

  app.post("/views", async (request, reply) => {
    requireWrite(request.principal);
    const input = parseBody(createSchema, request.body);
    const view = await createSavedView(
      request.db,
      request.principal.tenantId,
      request.principal.userId,
      input.name,
      parseTicketFilters(input.filters)
    );
    return reply.status(201).send({ view });
  });

  app.get("/views/:id/tickets", async (request) => {
    const view = await getSavedView(request.db, request.principal.tenantId, paramId(request, "id"));
    const page = pageFromQuery(request.query as Record<string, unknown>);
    const tickets = await listTickets(request.db, request.principal.tenantId, view.filters, page);
    return { view, tickets, limit: page.limit, offset: page.offset };
  });

  app.delete("/views/:id", async (request, reply) => {
    requireWrite(request.principal);
    await deleteSavedView(request.db, request.principal.tenantId, paramId(request, "id"));
    return reply.status(204).send();
  });
}
