import type { Queryable } from "@ticketry/db";

import type { Comment } from "../domain/types.js";
import { recordAudit } from "./audit.js";
import { COMMENT_COLUMNS, commentFromRow } from "./rows.js";
import type { CommentRow } from "./rows.js";
import { getTicket } from "./tickets.js";

export interface CreateCommentInput {
  body: string;
  isInternal: boolean;
  now?: Date;
}

export async function listComments(db: Queryable, tenantId: string, ticketId: string): Promise<Comment[]> {
  await getTicket(db, tenantId, ticketId);
  const result = await db.query<CommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM comments
     WHERE tenant_id = $1 AND ticket_id = $2
     ORDER BY created_at ASC, id ASC`,
    [tenantId, ticketId]
  );
  return result.rows.map(commentFromRow);
}

export async function createComment(
  db: Queryable,
  tenantId: string,
  authorId: string,
  ticketId: string,
  input: CreateCommentInput
): Promise<Comment> {
  const now = input.now ?? new Date();
  const ticket = await getTicket(db, tenantId, ticketId);
  const inserted = await db.query<CommentRow>(
    `INSERT INTO comments (tenant_id, ticket_id, author_id, body, is_internal, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COMMENT_COLUMNS}`,
    [tenantId, ticket.id, authorId, input.body, input.isInternal, now]
  );
  await db.query("UPDATE tickets SET updated_at = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, ticket.id, now]);
  const comment = commentFromRow(inserted.rows[0] as CommentRow);
  await recordAudit(db, {
    tenantId,
    actorId: authorId,
    action: "comment.created",
    targetType: "ticket",
    targetId: ticket.id,
    metadata: { commentId: comment.id, isInternal: comment.isInternal }
  });
  return comment;
}
