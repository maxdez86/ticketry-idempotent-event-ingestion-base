import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { enqueueExport, getExportJob, listExportJobs } from "@ticketry/core";

import { pageFromQuery, paramId, parseBody } from "../lib/http.js";
import { requireWrite } from "../plugins/auth.js";

const createSchema = z.object({
  viewId: z.string().uuid().nullable().default(null)
});

export function registerExportRoutes(app: FastifyInstance): void {
  app.get("/exports", async (request) => {
    const page = pageFromQuery(request.query as Record<string, unknown>);
    const jobs = await listExportJobs(request.db, request.principal.tenantId, page);
    return { exports: jobs.map((job) => ({ ...job, csv: undefined })), limit: page.limit, offset: page.offset };
  });

  app.post("/exports", async (request, reply) => {
    requireWrite(request.principal);
    const input = parseBody(createSchema, request.body);
    const job = await enqueueExport(request.db, request.principal.tenantId, request.principal.userId, input.viewId);
    return reply.status(202).send({ export: job });
  });

  app.get("/exports/:id", async (request) => {
    const job = await getExportJob(request.db, request.principal.tenantId, paramId(request, "id"));
    return { export: job };
  });

  app.get("/exports/:id/download", async (request, reply) => {
    const job = await getExportJob(request.db, request.principal.tenantId, paramId(request, "id"));
    if (job.status !== "done" || job.csv === null) {
      return reply.status(409).send({
        error: { code: "not_ready", message: `export is ${job.status}` }
      });
    }
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="tickets-${job.id}.csv"`)
      .send(job.csv);
  });
}
