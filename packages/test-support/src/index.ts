import { generateApiKey, hashApiKey } from "@ticketry/core";
import type { MembershipRole, TicketPriority, TicketStatus } from "@ticketry/core";
import { createPool } from "@ticketry/db";
import type { Pool } from "@ticketry/db";
import { adminUrlFromEnv, createEphemeralDatabase } from "@ticketry/db/testing";
import type { EphemeralDatabase } from "@ticketry/db/testing";

export interface TestTenant {
  id: string;
  slug: string;
  name: string;
}

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  isStaff: boolean;
}

export interface TestContext {
  db: EphemeralDatabase;
  /** Owner connection: fixtures and direct assertions. */
  admin: Pool;
  /** `ticketry_app` connection: what the code under test uses. */
  app: Pool;
  close(): Promise<void>;
}

export async function createTestContext(options: { appPoolMax?: number } = {}): Promise<TestContext> {
  const db = await createEphemeralDatabase(adminUrlFromEnv());
  const admin = createPool({ connectionString: db.adminUrl, max: 3, applicationName: "ticketry-test-admin" });
  const app = createPool({
    connectionString: db.appUrl,
    max: options.appPoolMax ?? 4,
    applicationName: "ticketry-test-app"
  });
  return {
    db,
    admin,
    app,
    async close() {
      await app.end();
      await admin.end();
      await db.drop();
    }
  };
}

let counter = 0;
function next(): number {
  counter += 1;
  return counter;
}

export async function createTenant(admin: Pool, slug = `tenant-${next()}`): Promise<TestTenant> {
  const result = await admin.query<{ id: string; slug: string; name: string }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug, name",
    [slug, slug.replace(/-/g, " ")]
  );
  return result.rows[0] as TestTenant;
}

export async function createUser(
  admin: Pool,
  input: { email?: string; displayName?: string; isStaff?: boolean } = {}
): Promise<TestUser> {
  const n = next();
  const result = await admin.query<{ id: string; email: string; display_name: string; is_staff: boolean }>(
    "INSERT INTO users (email, display_name, is_staff) VALUES ($1, $2, $3) RETURNING id, email, display_name, is_staff",
    [input.email ?? `user-${n}@example.test`, input.displayName ?? `User ${n}`, input.isStaff ?? false]
  );
  const row = result.rows[0]!;
  return { id: row.id, email: row.email, displayName: row.display_name, isStaff: row.is_staff };
}

export async function addMembership(
  admin: Pool,
  tenantId: string,
  userId: string,
  role: MembershipRole = "agent"
): Promise<void> {
  await admin.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)", [
    tenantId,
    userId,
    role
  ]);
}

export async function revokeMembership(admin: Pool, tenantId: string, userId: string): Promise<void> {
  await admin.query("UPDATE memberships SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2", [
    tenantId,
    userId
  ]);
}

/** Returns the plain key; only its hash is stored. */
export async function createApiKey(
  admin: Pool,
  input: { tenantId: string | null; userId: string; label?: string }
): Promise<string> {
  const key = generateApiKey();
  await admin.query("INSERT INTO api_keys (tenant_id, user_id, key_hash, label) VALUES ($1, $2, $3, $4)", [
    input.tenantId,
    input.userId,
    hashApiKey(key),
    input.label ?? "test"
  ]);
  return key;
}

export async function revokeApiKey(admin: Pool, plainKey: string): Promise<void> {
  await admin.query("UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1", [hashApiKey(plainKey)]);
}

/** A member with an API key, ready to call the API as that workspace. */
export async function createMember(
  admin: Pool,
  tenantId: string,
  role: MembershipRole = "agent"
): Promise<{ user: TestUser; apiKey: string }> {
  const user = await createUser(admin);
  await addMembership(admin, tenantId, user.id, role);
  const apiKey = await createApiKey(admin, { tenantId, userId: user.id });
  return { user, apiKey };
}

export interface SeedTicketInput {
  tenantId: string;
  requesterId: string;
  subject?: string;
  body?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  slaDueAt?: Date | null;
  createdAt?: Date;
}

/** Insert a ticket directly, bypassing the application layer. */
export async function seedTicket(admin: Pool, input: SeedTicketInput): Promise<{ id: string; number: number }> {
  const counter = await admin.query<{ number: number }>(
    `INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 2)
     ON CONFLICT (tenant_id) DO UPDATE SET next_number = ticket_counters.next_number + 1
     RETURNING next_number - 1 AS number`,
    [input.tenantId]
  );
  const number = counter.rows[0]!.number;
  const createdAt = input.createdAt ?? new Date();
  const result = await admin.query<{ id: string }>(
    `INSERT INTO tickets (tenant_id, number, subject, body, status, priority, requester_id, assignee_id,
                          sla_due_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
    [
      input.tenantId,
      number,
      input.subject ?? `Ticket ${number}`,
      input.body ?? "",
      input.status ?? "open",
      input.priority ?? "normal",
      input.requesterId,
      input.assigneeId ?? null,
      input.slaDueAt === undefined ? new Date(createdAt.getTime() + 24 * 3600 * 1000) : input.slaDueAt,
      createdAt
    ]
  );
  return { id: result.rows[0]!.id, number };
}

export interface LifecycleFixtures {
  tenants: [TestTenant, TestTenant];
  tickets: [{ tenantId: string; id: string; number: number }, { tenantId: string; id: string; number: number }];
  members: [{ tenantId: string; user: TestUser }, { tenantId: string; user: TestUser }];
}

export async function createLifecycleFixtures(admin: Pool): Promise<LifecycleFixtures> {
  const firstTenant = await createTenant(admin);
  const secondTenant = await createTenant(admin);
  const firstUser = await createUser(admin);
  const secondUser = await createUser(admin);
  await addMembership(admin, firstTenant.id, firstUser.id, "agent");
  await addMembership(admin, secondTenant.id, secondUser.id, "agent");
  const firstTicket = await seedTicket(admin, { tenantId: firstTenant.id, requesterId: firstUser.id });
  const secondTicket = await seedTicket(admin, { tenantId: secondTenant.id, requesterId: secondUser.id });
  return {
    tenants: [firstTenant, secondTenant],
    tickets: [
      { tenantId: firstTenant.id, ...firstTicket },
      { tenantId: secondTenant.id, ...secondTicket }
    ],
    members: [
      { tenantId: firstTenant.id, user: firstUser },
      { tenantId: secondTenant.id, user: secondUser }
    ]
  };
}

export async function seedLifecycleTicket(
  admin: Pool,
  input: SeedTicketInput & { tenantId: string }
): Promise<{ id: string; number: number }> {
  return seedTicket(admin, input);
}

export async function seedComment(
  admin: Pool,
  input: { tenantId: string; ticketId: string; authorId: string; body: string; isInternal?: boolean }
): Promise<string> {
  const result = await admin.query<{ id: string }>(
    `INSERT INTO comments (tenant_id, ticket_id, author_id, body, is_internal)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.tenantId, input.ticketId, input.authorId, input.body, input.isInternal ?? false]
  );
  return result.rows[0]!.id;
}
