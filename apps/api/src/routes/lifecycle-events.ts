import type { FastifyInstance } from "fastify";

import { getTicket, providerEventSchema, runLifecycleIngestion } from "@ticketry/core";
import type { Pool } from "@ticketry/db";

import { badRequest, parseBody } from "../lib/http.js";
import { requireStaff } from "../plugins/auth.js";

export function registerLifecycleEventRoutes(app: FastifyInstance, lifecyclePool: Pool): void {
  app.post("/lifecycle-events", async (request) => {
    requireStaff(request.principal);
    const event = parseBody(providerEventSchema, request.body);
    if (event.workspace_slug !== request.principal.tenantSlug) {
      throw badRequest("workspace_slug must match x-ticketry-tenant");
    }

    await getTicket(request.db, request.principal.tenantId, event.ticket_id);
    await runLifecycleIngestion(lifecyclePool, [event]);
    const ticket = await getTicket(request.db, request.principal.tenantId, event.ticket_id);
    return { eventId: event.event_id, ticket };
  });
}
