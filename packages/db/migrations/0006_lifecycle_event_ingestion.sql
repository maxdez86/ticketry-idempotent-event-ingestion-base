CREATE TABLE lifecycle_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  ticket_id        uuid NOT NULL,
  event_id         text NOT NULL,
  ticket_sequence  integer NOT NULL CHECK (ticket_sequence > 0),
  kind             text NOT NULL,
  payload          jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_events_ticket_tenant_fkey
    FOREIGN KEY (ticket_id, tenant_id)
    REFERENCES tickets (id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX lifecycle_events_tenant_ticket_idx ON lifecycle_events (tenant_id, ticket_id, created_at);

ALTER TABLE lifecycle_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY lifecycle_events_tenant_isolation ON lifecycle_events
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

GRANT SELECT, INSERT ON lifecycle_events TO ticketry_app;
