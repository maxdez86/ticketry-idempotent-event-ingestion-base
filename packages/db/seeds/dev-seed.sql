-- Local development data. Safe to re-run: every statement is idempotent.
-- API keys (plain text, for local use only):
--   tk_acme_owner_5c1d0c2a7f4e4b3a    owner  @ acme
--   tk_acme_agent_9a8b7c6d5e4f3a2b    agent  @ acme   (dana, who is also an agent at globex)
--   tk_globex_owner_1f2e3d4c5b6a7980  owner  @ globex
--   tk_globex_agent_0a1b2c3d4e5f6a7b  agent  @ globex (dana)
--   tk_staff_support_77aa88bb99cc00dd         platform staff, selects the workspace with X-Ticketry-Tenant

INSERT INTO tenants (id, slug, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'acme', 'Acme Corp'),
  ('22222222-2222-4222-8222-222222222222', 'globex', 'Globex Ltd')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (id, email, display_name, is_staff) VALUES
  ('aaaaaaaa-0001-4000-8000-000000000001', 'alice@acme.example', 'Alice Acme', false),
  ('aaaaaaaa-0002-4000-8000-000000000002', 'dana@agents.example', 'Dana Agent', false),
  ('aaaaaaaa-0003-4000-8000-000000000003', 'gus@globex.example', 'Gus Globex', false),
  ('aaaaaaaa-0004-4000-8000-000000000004', 'rita@acme.example', 'Rita Requester', false),
  ('aaaaaaaa-0005-4000-8000-000000000005', 'support@ticketry.example', 'Ticketry Support', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (tenant_id, user_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0001-4000-8000-000000000001', 'owner'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0002-4000-8000-000000000002', 'agent'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0004-4000-8000-000000000004', 'viewer'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0003-4000-8000-000000000003', 'owner'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0002-4000-8000-000000000002', 'agent')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

INSERT INTO api_keys (tenant_id, user_id, key_hash, label) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0001-4000-8000-000000000001', '532c378f5be201b231a6117fbe736455b3d1cc4d5a0cbdc3d8841a766e947def', 'acme owner'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0002-4000-8000-000000000002', '00e7a50bc32c3ded11b27199b3894563d565a4906f6c1cdafcc46e6531c15185', 'acme agent'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0003-4000-8000-000000000003', 'f28b2efdcb4e3db37cd37888820f467c5afa64f251ef6336eac736c6659a80a6', 'globex owner'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0002-4000-8000-000000000002', 'a67d0aa7c1138b57c871839d311c104cdb3e83663ab7f450d93c99932f96db98', 'globex agent'),
  (NULL, 'aaaaaaaa-0005-4000-8000-000000000005', '286e558e5929afc7b7f3fc94089932050f036db99f4f858edc0be002ea74b47f', 'platform staff')
ON CONFLICT (key_hash) DO NOTHING;

INSERT INTO ticket_counters (tenant_id, next_number) VALUES
  ('11111111-1111-4111-8111-111111111111', 3),
  ('22222222-2222-4222-8222-222222222222', 2)
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO tickets (id, tenant_id, number, subject, body, status, priority, requester_id, assignee_id, sla_due_at) VALUES
  ('bbbbbbbb-0001-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 1,
   'Cannot export invoices', 'The invoice export button spins forever.', 'open', 'high',
   'aaaaaaaa-0004-4000-8000-000000000004', 'aaaaaaaa-0002-4000-8000-000000000002', now() + interval '8 hours'),
  ('bbbbbbbb-0002-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 2,
   'Add SSO for the finance team', 'We would like SAML login.', 'pending', 'normal',
   'aaaaaaaa-0001-4000-8000-000000000001', NULL, now() + interval '24 hours'),
  ('bbbbbbbb-0003-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 1,
   'Webhook retries never stop', 'Our endpoint returns 410 but retries continue.', 'open', 'urgent',
   'aaaaaaaa-0003-4000-8000-000000000003', 'aaaaaaaa-0002-4000-8000-000000000002', now() + interval '4 hours')
ON CONFLICT (id) DO NOTHING;

INSERT INTO comments (tenant_id, ticket_id, author_id, body, is_internal) VALUES
  ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0001-4000-8000-000000000001',
   'aaaaaaaa-0002-4000-8000-000000000002', 'Reproduced on staging, looks like a timeout in the PDF renderer.', true),
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-0003-4000-8000-000000000003',
   'aaaaaaaa-0002-4000-8000-000000000002', 'Escalated to the integrations team.', false)
ON CONFLICT DO NOTHING;
