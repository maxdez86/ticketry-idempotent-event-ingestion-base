import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createComment, listComments } from "@ticketry/core";

import { paramId, parseBody } from "../lib/http.js";
import { requireWrite } from "../plugins/auth.js";

const createSchema = z.object({
  body: z.string().min(1).max(20_000),
  isInternal: z.boolean().default(false)
});

export function registerCommentRoutes(app: FastifyInstance): void {
  app.get("/tickets/:id/comments", async (request) => {
    const comments = await listComments(request.db, request.principal.tenantId, paramId(request, "id"));
    // Viewers never see internal notes.
    const visible = request.principal.role === "viewer" ? comments.filter((c) => !c.isInternal) : comments;
    return { comments: visible };
  });

  app.post("/tickets/:id/comments", async (request, reply) => {
    requireWrite(request.principal);
    const input = parseBody(createSchema, request.body);
    const comment = await createComment(
      request.db,
      request.principal.tenantId,
      request.principal.userId,
      paramId(request, "id"),
      input
    );
    return reply.status(201).send({ comment });
  });
}
