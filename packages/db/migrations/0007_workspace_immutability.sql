-- A row never changes workspace, for the owner as much as for the runtime role.
--
-- Row-level security binds only the non-owning runtime role, and the composite
-- keys of 0005 refuse a move only while dependent rows still point at the old
-- workspace. Neither stops the owner from moving a row that nothing references
-- yet, so every workspace-owned table gets a trigger that refuses any change to
-- the column that names its workspace.

CREATE FUNCTION ticketry.reject_workspace_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'rows cannot move between workspaces (%.%)', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

REVOKE ALL ON FUNCTION ticketry.reject_workspace_change() FROM PUBLIC;

CREATE TRIGGER tenants_workspace_immutable
  BEFORE UPDATE OF id ON public.tenants
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id)
  EXECUTE FUNCTION ticketry.reject_workspace_change();

DO $immutable$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memberships', 'api_keys', 'ticket_counters', 'tickets', 'comments', 'tags',
    'ticket_tags', 'audit_log', 'saved_views', 'export_jobs', 'notification_outbox'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OF tenant_id ON public.%I
         FOR EACH ROW WHEN (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id)
         EXECUTE FUNCTION ticketry.reject_workspace_change()',
      target || '_workspace_immutable', target
    );
  END LOOP;
END
$immutable$;
