-- SLA tracking on tickets, saved views, CSV export jobs, and the notification
-- outbox consumed by the worker.

ALTER TABLE tickets
  ADD COLUMN sla_due_at   timestamptz,
  ADD COLUMN sla_breached boolean NOT NULL DEFAULT false;
CREATE INDEX tickets_sla_due_idx ON tickets (sla_due_at)
  WHERE sla_due_at IS NOT NULL AND sla_breached = false;

CREATE TABLE saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users (id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_id, name)
);

CREATE TABLE export_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL REFERENCES users (id),
  view_id       uuid REFERENCES saved_views (id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'failed')),
  row_count     integer,
  csv           text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX export_jobs_queue_idx ON export_jobs (created_at) WHERE status = 'queued';
CREATE INDEX export_jobs_tenant_idx ON export_jobs (tenant_id, created_at DESC);

CREATE TABLE notification_outbox (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox (created_at) WHERE sent_at IS NULL;
