import type { Queryable } from "@ticketry/db";

import type { Page } from "../domain/types.js";

export interface SearchHit {
  ticketId: string;
  number: number;
  subject: string;
  status: string;
  matchedIn: "ticket" | "comment";
}

interface SearchRow {
  ticket_id: string;
  number: number;
  subject: string;
  status: string;
  matched_in: "ticket" | "comment";
}

/**
 * Full-text search across ticket subjects/bodies and comment bodies.
 * Results are de-duplicated per ticket, preferring the ticket match.
 */
export async function searchTickets(
  db: Queryable,
  tenantId: string,
  query: string,
  page: Page
): Promise<SearchHit[]> {
  const result = await db.query<SearchRow>(
    `WITH hits AS (
       SELECT t.id AS ticket_id, t.number, t.subject, t.status, t.created_at,
              'ticket'::text AS matched_in, 0 AS rank_group
       FROM tickets t
       WHERE t.tenant_id = $1
         AND to_tsvector('simple', t.subject || ' ' || t.body) @@ plainto_tsquery('simple', $2)
       UNION ALL
       SELECT t.id AS ticket_id, t.number, t.subject, t.status, t.created_at,
              'comment'::text AS matched_in, 1 AS rank_group
       FROM comments c
       JOIN tickets t ON t.id = c.ticket_id AND t.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1
         AND t.tenant_id = $1
         AND to_tsvector('simple', c.body) @@ plainto_tsquery('simple', $2)
     ),
     ranked AS (
       SELECT DISTINCT ON (ticket_id) ticket_id, number, subject, status, created_at, matched_in
       FROM hits
       ORDER BY ticket_id, rank_group
     )
     SELECT ticket_id, number, subject, status, matched_in
     FROM ranked
     ORDER BY created_at DESC, number DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, query, page.limit, page.offset]
  );
  return result.rows.map((row) => ({
    ticketId: row.ticket_id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    matchedIn: row.matched_in
  }));
}
