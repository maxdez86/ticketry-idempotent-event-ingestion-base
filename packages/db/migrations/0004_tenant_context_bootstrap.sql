-- Controlled database entry points used to establish tenant scope before RLS
-- is enabled. The migration owner retains ownership of the schema and functions.

CREATE SCHEMA ticketry;
REVOKE ALL ON SCHEMA ticketry FROM PUBLIC;
GRANT USAGE ON SCHEMA ticketry TO ticketry_app;

CREATE FUNCTION ticketry.current_tenant_id()
RETURNS pg_catalog.uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('ticketry.tenant_id', true), '')::pg_catalog.uuid
$$;

CREATE FUNCTION ticketry.authenticate_api_key(p_key_hash pg_catalog.text)
RETURNS TABLE (
  api_key_id pg_catalog.uuid,
  tenant_id pg_catalog.uuid,
  user_id pg_catalog.uuid,
  email pg_catalog.text,
  display_name pg_catalog.text,
  is_staff pg_catalog.bool,
  memberships pg_catalog.jsonb
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH authenticated AS (
    UPDATE public.api_keys AS key
    SET last_used_at = pg_catalog.now()
    FROM public.users AS app_user
    WHERE key.key_hash = p_key_hash
      AND key.user_id = app_user.id
      AND key.revoked_at IS NULL
      AND app_user.disabled_at IS NULL
    RETURNING
      key.id AS api_key_id,
      key.tenant_id,
      app_user.id AS user_id,
      app_user.email,
      app_user.display_name,
      app_user.is_staff
  )
  SELECT
    authenticated.api_key_id,
    authenticated.tenant_id,
    authenticated.user_id,
    authenticated.email,
    authenticated.display_name,
    authenticated.is_staff,
    COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('tenantSlug', tenant.slug, 'role', membership.role)
          ORDER BY tenant.slug
        )
        FROM public.memberships AS membership
        JOIN public.tenants AS tenant ON tenant.id = membership.tenant_id
        WHERE membership.user_id = authenticated.user_id
          AND membership.revoked_at IS NULL
      ),
      '[]'::pg_catalog.jsonb
    ) AS memberships
  FROM authenticated
$$;

CREATE FUNCTION ticketry.resolve_staff_tenant(p_slug pg_catalog.text)
RETURNS TABLE (
  tenant_id pg_catalog.uuid,
  tenant_slug pg_catalog.text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT tenant.id, tenant.slug
  FROM public.tenants AS tenant
  WHERE tenant.slug = p_slug
$$;

CREATE FUNCTION ticketry.worker_tenant_ids()
RETURNS TABLE (tenant_id pg_catalog.uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT tenant.id
  FROM public.tenants AS tenant
  ORDER BY tenant.id
$$;

REVOKE ALL ON FUNCTION ticketry.current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION ticketry.authenticate_api_key(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ticketry.resolve_staff_tenant(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ticketry.worker_tenant_ids() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ticketry.current_tenant_id() TO ticketry_app;
GRANT EXECUTE ON FUNCTION ticketry.authenticate_api_key(pg_catalog.text) TO ticketry_app;
GRANT EXECUTE ON FUNCTION ticketry.resolve_staff_tenant(pg_catalog.text) TO ticketry_app;
GRANT EXECUTE ON FUNCTION ticketry.worker_tenant_ids() TO ticketry_app;
