-- Core helpdesk schema: workspaces (tenants), identities, memberships, API
-- keys, tickets, comments, tags, and the audit log.

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Users are global identities. The same person can belong to several tenants.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL,
  is_staff      boolean NOT NULL DEFAULT false,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE memberships (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'agent', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

-- A key belongs to a user. Tenant keys act inside one workspace; platform
-- staff keys have no tenant and pick the workspace per request.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_hash      text NOT NULL UNIQUE,
  label         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

CREATE TABLE ticket_counters (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  next_number  integer NOT NULL DEFAULT 1
);

CREATE TABLE tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number        integer NOT NULL,
  subject       text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'pending', 'solved', 'closed')),
  priority      text NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  requester_id  uuid NOT NULL REFERENCES users (id),
  assignee_id   uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX tickets_tenant_status_idx ON tickets (tenant_id, status, created_at DESC);
CREATE INDEX tickets_assignee_idx ON tickets (assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX tickets_search_idx ON tickets
  USING gin (to_tsvector('simple', subject || ' ' || body));

CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id    uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  author_id    uuid NOT NULL REFERENCES users (id),
  body         text NOT NULL CHECK (length(body) >= 1),
  is_internal  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_ticket_idx ON comments (ticket_id, created_at);
CREATE INDEX comments_search_idx ON comments USING gin (to_tsvector('simple', body));

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  UNIQUE (tenant_id, name)
);

CREATE TABLE ticket_tags (
  ticket_id  uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, tag_id)
);
CREATE INDEX ticket_tags_tag_idx ON ticket_tags (tag_id);

-- Append-only record of who did what. tenant_id is NULL for platform-level
-- events (for example staff signing in).
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid REFERENCES tenants (id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users (id),
  action       text NOT NULL,
  target_type  text NOT NULL,
  target_id    text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC);
