-- 0001_foundation.sql
-- Finagai Core, Schema v0 foundation: schema, shared types, helper functions.
-- Runs as the migration role (finagai_migrator). Never edit after release; add a new migration instead.
--
-- Prerequisite (created outside migrations, see docs/runbooks/provisioning.md):
--   finagai_migrator  LOGIN role that owns all objects
--   finagai_app       LOGIN role used by the running service

BEGIN;

CREATE SCHEMA IF NOT EXISTS finagai;
SET search_path = finagai, public;

-- Classification tiers (ADR-016, ADR-020, ADR-021).
-- 'highly_sensitive' and 'prohibited' exist as values so policy can evolve without a type change;
-- per-table CHECK constraints decide what may actually be stored.
CREATE TYPE classification_level AS ENUM (
  'public', 'internal', 'confidential', 'highly_sensitive', 'prohibited'
);

CREATE TYPE event_actor AS ENUM (
  'julian', 'j2', 'j3', 'seed', 'job', 'migration', 'system'
);

-- Keep updated_at current on every UPDATE.
CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Immutable join for generated search columns (array_to_string is only STABLE).
CREATE FUNCTION immutable_join(text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;

-- Append-only enforcement for the audit log (G14). No role may UPDATE, DELETE, or TRUNCATE events.
-- If an emergency correction is ever required, it is done by a reviewed migration that
-- explicitly disables this trigger, and is itself recorded as an event.
CREATE FUNCTION reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finagai.event is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMIT;
