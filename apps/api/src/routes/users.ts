import type { FastifyInstance } from "fastify";

import { getTenantMember, listTenantMembers } from "@ticketry/core";

import { paramId } from "../lib/http.js";

export function registerUserRoutes(app: FastifyInstance): void {
  app.get("/me", async (request) => {
    const { principal } = request;
    return {
      user: {
        id: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        isStaff: principal.isStaff
      },
      workspace: { id: principal.tenantId, slug: principal.tenantSlug, role: principal.role },
      memberships: principal.memberships
    };
  });

  app.get("/users", async (request) => {
    return { users: await listTenantMembers(request.db, request.principal.tenantId) };
  });

  app.get("/users/:id", async (request) => {
    const userId = paramId(request, "id");
    const { role, ...user } = await getTenantMember(request.db, request.principal.tenantId, userId);
    return {
      user,
      memberships: [
        {
          tenantId: request.principal.tenantId,
          tenantSlug: request.principal.tenantSlug,
          role,
          revokedAt: null
        }
      ]
    };
  });
}
