import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  countTickets,
  createTicket,
  getTicket,
  listTickets,
  parseTicketFilters,
  updateTicket
} from "@ticketry/core";

import { pageFromQuery, paramId, parseBody } from "../lib/http.js";
import { requireWrite } from "../plugins/auth.js";

const createSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().max(20_000).default(""),
  priority: z.enum(TICKET_PRIORITIES).default("normal"),
  requesterId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().nullable().default(null)
});

const updateSchema = z
  .object({
    subject: z.string().min(1).max(200).optional(),
    body: z.string().max(20_000).optional(),
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    assigneeId: z.string().uuid().nullable().optional()
  })
  .strict();

export function registerTicketRoutes(app: FastifyInstance): void {
  app.get("/tickets", async (request) => {
    const query = request.query as Record<string, unknown>;
    const { limit, offset, ...filterQuery } = query;
    void limit;
    void offset;
    const filters = parseTicketFilters(filterQuery);
    const page = pageFromQuery(query);
    const [tickets, total] = await Promise.all([
      listTickets(request.db, request.principal.tenantId, filters, page),
      countTickets(request.db, request.principal.tenantId, filters)
    ]);
    return { tickets, total, limit: page.limit, offset: page.offset };
  });

  app.post("/tickets", async (request, reply) => {
    requireWrite(request.principal);
    const input = parseBody(createSchema, request.body);
    const ticket = await createTicket(request.db, request.principal.tenantId, request.principal.userId, {
      subject: input.subject,
      body: input.body,
      priority: input.priority,
      requesterId: input.requesterId ?? request.principal.userId,
      assigneeId: input.assigneeId
    });
    return reply.status(201).send({ ticket });
  });

  app.get("/tickets/:id", async (request) => {
    const ticket = await getTicket(request.db, request.principal.tenantId, paramId(request, "id"));
    return { ticket };
  });

  app.patch("/tickets/:id", async (request) => {
    requireWrite(request.principal);
    const input = parseBody(updateSchema, request.body);
    const ticket = await updateTicket(
      request.db,
      request.principal.tenantId,
      request.principal.userId,
      paramId(request, "id"),
      input
    );
    return { ticket };
  });
}
