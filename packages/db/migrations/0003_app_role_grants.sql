-- The API and the worker connect as ticketry_app. The role never owns any
-- object; it only receives DML on the application tables. Roles are
-- cluster-wide, so create it when missing and tolerate a concurrent creator.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketry_app') THEN
    BEGIN
      CREATE ROLE ticketry_app NOLOGIN;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ticketry_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants,
  users,
  memberships,
  api_keys,
  ticket_counters,
  tickets,
  comments,
  tags,
  ticket_tags,
  audit_log,
  saved_views,
  export_jobs,
  notification_outbox
TO ticketry_app;

GRANT USAGE, SELECT ON
  audit_log_id_seq,
  notification_outbox_id_seq
TO ticketry_app;

-- schema_migrations stays readable so the runtime can report its version.
GRANT SELECT ON schema_migrations TO ticketry_app;
