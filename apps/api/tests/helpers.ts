import type { FastifyInstance } from "fastify";

import { createMember, createTenant, createTestContext } from "@ticketry/test-support";
import type { TestContext, TestTenant, TestUser } from "@ticketry/test-support";

import { buildApp } from "../src/app.js";

export interface ApiHarness {
  ctx: TestContext;
  app: FastifyInstance;
  tenant: TestTenant;
  owner: { user: TestUser; apiKey: string };
  agent: { user: TestUser; apiKey: string };
  viewer: { user: TestUser; apiKey: string };
  close(): Promise<void>;
}

export async function startApi(options: { appPoolMax?: number } = {}): Promise<ApiHarness> {
  const ctx = await createTestContext(options);
  const app = buildApp({ pool: ctx.app });
  await app.ready();
  const tenant = await createTenant(ctx.admin);
  const owner = await createMember(ctx.admin, tenant.id, "owner");
  const agent = await createMember(ctx.admin, tenant.id, "agent");
  const viewer = await createMember(ctx.admin, tenant.id, "viewer");
  return {
    ctx,
    app,
    tenant,
    owner,
    agent,
    viewer,
    async close() {
      await app.close();
      await ctx.close();
    }
  };
}

export function auth(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

export async function createTicketVia(
  app: FastifyInstance,
  apiKey: string,
  body: Record<string, unknown> = {}
): Promise<{ id: string; number: number; [key: string]: unknown }> {
  const response = await app.inject({
    method: "POST",
    url: "/tickets",
    headers: auth(apiKey),
    payload: { subject: "Printer on fire", body: "Literally.", ...body }
  });
  if (response.statusCode !== 201) {
    throw new Error(`ticket creation failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().ticket;
}
