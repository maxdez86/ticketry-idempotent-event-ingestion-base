-- Make tenant isolation a database-enforced invariant. The migration runner
-- applies this file in one transaction, so every preflight and schema change
-- either succeeds together or is rolled back together.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.comments AS comment
    JOIN public.tickets AS ticket ON ticket.id = comment.ticket_id
    WHERE comment.tenant_id <> ticket.tenant_id
  ) THEN
    RAISE EXCEPTION 'cannot enable tenant constraints: comments contain cross-tenant ticket references';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.export_jobs AS export_job
    JOIN public.saved_views AS saved_view ON saved_view.id = export_job.view_id
    WHERE export_job.view_id IS NOT NULL
      AND export_job.tenant_id <> saved_view.tenant_id
  ) THEN
    RAISE EXCEPTION 'cannot enable tenant constraints: export jobs contain cross-tenant saved-view references';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.ticket_tags AS ticket_tag
    JOIN public.tickets AS ticket ON ticket.id = ticket_tag.ticket_id
    JOIN public.tags AS tag ON tag.id = ticket_tag.tag_id
    WHERE ticket.tenant_id <> tag.tenant_id
  ) THEN
    RAISE EXCEPTION 'cannot enable tenant constraints: ticket/tag links cross tenant boundaries';
  END IF;
END
$$;

-- Composite referenced keys let each relationship prove that its tenant and
-- object id describe the same row. Keeping id first preserves the useful
-- access path supplied by the existing primary keys.
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE public.tags
  ADD CONSTRAINT tags_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE public.saved_views
  ADD CONSTRAINT saved_views_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE public.comments
  DROP CONSTRAINT comments_ticket_id_fkey,
  ADD CONSTRAINT comments_ticket_tenant_fkey
    FOREIGN KEY (ticket_id, tenant_id)
    REFERENCES public.tickets (id, tenant_id)
    ON DELETE CASCADE;

ALTER TABLE public.export_jobs
  DROP CONSTRAINT export_jobs_view_id_fkey,
  ADD CONSTRAINT export_jobs_view_tenant_fkey
    FOREIGN KEY (view_id, tenant_id)
    REFERENCES public.saved_views (id, tenant_id)
    ON DELETE SET NULL (view_id);

ALTER TABLE public.ticket_tags
  ADD COLUMN tenant_id uuid;

-- The preflight above established that the ticket and tag agree, so this
-- backfill copies their already-consistent tenant instead of guessing one.
UPDATE public.ticket_tags AS ticket_tag
SET tenant_id = ticket.tenant_id
FROM public.tickets AS ticket
WHERE ticket.id = ticket_tag.ticket_id;

ALTER TABLE public.ticket_tags
  ALTER COLUMN tenant_id SET NOT NULL,
  DROP CONSTRAINT ticket_tags_ticket_id_fkey,
  DROP CONSTRAINT ticket_tags_tag_id_fkey,
  ADD CONSTRAINT ticket_tags_ticket_tenant_fkey
    FOREIGN KEY (ticket_id, tenant_id)
    REFERENCES public.tickets (id, tenant_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT ticket_tags_tag_tenant_fkey
    FOREIGN KEY (tag_id, tenant_id)
    REFERENCES public.tags (id, tenant_id)
    ON DELETE CASCADE;

-- The owning migration role deliberately keeps PostgreSQL's normal owner
-- access. The non-owning runtime role is subject to every policy below.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_tenant_isolation ON public.tenants
  FOR ALL TO ticketry_app
  USING (id = ticketry.current_tenant_id())
  WITH CHECK (id = ticketry.current_tenant_id());

CREATE POLICY memberships_tenant_isolation ON public.memberships
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY api_keys_tenant_isolation ON public.api_keys
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY ticket_counters_tenant_isolation ON public.ticket_counters
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY tickets_tenant_isolation ON public.tickets
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY comments_tenant_isolation ON public.comments
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY tags_tenant_isolation ON public.tags
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY ticket_tags_tenant_isolation ON public.ticket_tags
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY audit_log_tenant_isolation ON public.audit_log
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY saved_views_tenant_isolation ON public.saved_views
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY export_jobs_tenant_isolation ON public.export_jobs
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

CREATE POLICY notification_outbox_tenant_isolation ON public.notification_outbox
  FOR ALL TO ticketry_app
  USING (tenant_id = ticketry.current_tenant_id())
  WITH CHECK (tenant_id = ticketry.current_tenant_id());

-- Replace the broad migration-0003 grants with the least privileges used by
-- the API and workers. API-key authentication and unscoped tenant discovery
-- remain available only through migration-0004's controlled functions.
REVOKE ALL PRIVILEGES ON TABLE
  public.tenants,
  public.users,
  public.memberships,
  public.api_keys,
  public.ticket_counters,
  public.tickets,
  public.comments,
  public.tags,
  public.ticket_tags,
  public.audit_log,
  public.saved_views,
  public.export_jobs,
  public.notification_outbox
FROM ticketry_app;

GRANT SELECT ON TABLE
  public.tenants,
  public.users,
  public.memberships
TO ticketry_app;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.ticket_counters,
  public.tickets,
  public.tags,
  public.export_jobs
TO ticketry_app;

GRANT SELECT, INSERT ON TABLE
  public.comments,
  public.audit_log,
  public.notification_outbox
TO ticketry_app;

GRANT SELECT, INSERT, DELETE ON TABLE
  public.ticket_tags,
  public.saved_views
TO ticketry_app;

REVOKE ALL PRIVILEGES ON SEQUENCE
  public.audit_log_id_seq,
  public.notification_outbox_id_seq
FROM ticketry_app;

GRANT USAGE ON SEQUENCE
  public.audit_log_id_seq,
  public.notification_outbox_id_seq
TO ticketry_app;

ALTER ROLE ticketry_app NOSUPERUSER NOBYPASSRLS;
