-- Runs once, when the local volume is first created.
-- The runtime role only ever receives the grants applied by the migrations;
-- it never owns tables. The migrations create it as NOLOGIN when it is
-- missing, so this script only exists to give the local role a password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketry_app') THEN
    CREATE ROLE ticketry_app NOLOGIN;
  END IF;
END
$$;

ALTER ROLE ticketry_app WITH LOGIN PASSWORD 'ticketry_app';

CREATE DATABASE ticketry_dev;
