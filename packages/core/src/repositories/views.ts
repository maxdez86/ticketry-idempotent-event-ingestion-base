import type { Queryable } from "@ticketry/db";

import type { SavedView, TicketFilters } from "../domain/types.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { SAVED_VIEW_COLUMNS, savedViewFromRow } from "./rows.js";
import type { SavedViewRow } from "./rows.js";

export async function createSavedView(
  db: Queryable,
  tenantId: string,
  ownerId: string,
  name: string,
  filters: TicketFilters
): Promise<SavedView> {
  try {
    const result = await db.query<SavedViewRow>(
      `INSERT INTO saved_views (tenant_id, owner_id, name, filters)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SAVED_VIEW_COLUMNS}`,
      [tenantId, ownerId, name, JSON.stringify(filters)]
    );
    return savedViewFromRow(result.rows[0] as SavedViewRow);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw new ConflictError(`a view named "${name}" already exists`);
    }
    throw error;
  }
}

export async function listSavedViews(db: Queryable, tenantId: string): Promise<SavedView[]> {
  const result = await db.query<SavedViewRow>(
    `SELECT ${SAVED_VIEW_COLUMNS} FROM saved_views WHERE tenant_id = $1 ORDER BY name`,
    [tenantId]
  );
  return result.rows.map(savedViewFromRow);
}

export async function getSavedView(db: Queryable, tenantId: string, viewId: string): Promise<SavedView> {
  const view = await findSavedView(db, tenantId, viewId);
  if (!view) {
    throw new NotFoundError("view", viewId);
  }
  return view;
}

export async function findSavedView(db: Queryable, tenantId: string, viewId: string): Promise<SavedView | null> {
  const result = await db.query<SavedViewRow>(
    `SELECT ${SAVED_VIEW_COLUMNS} FROM saved_views WHERE tenant_id = $1 AND id = $2`,
    [tenantId, viewId]
  );
  const row = result.rows[0];
  return row ? savedViewFromRow(row) : null;
}

export async function deleteSavedView(db: Queryable, tenantId: string, viewId: string): Promise<void> {
  const result = await db.query("DELETE FROM saved_views WHERE tenant_id = $1 AND id = $2", [tenantId, viewId]);
  if (result.rowCount === 0) {
    throw new NotFoundError("view", viewId);
  }
}
