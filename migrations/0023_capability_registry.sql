-- 0023_capability_registry.sql
-- Phase 2 (ADR-073): a runtime-queryable registry of everything Finagai can use, with health, permissions,
-- operations, empirical reliability/latency/cost, risk and freshness. Rows are DISCOVERED and REFRESHED by
-- code (src/resources/registry.ts), never hand-maintained prompt prose.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE capability (
  id            text PRIMARY KEY,                 -- 'mac.filesystem', 'google.gmail', 'finagai.projects', ...
  type          text NOT NULL CHECK (type IN ('state','mac','external','agent','model')),
  scope         text NOT NULL,                    -- human description of what it covers
  access        text NOT NULL CHECK (access IN ('read','write','read_write')),
  operations    text[] NOT NULL DEFAULT '{}',
  permissions   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"approval":"per_write","principal_only":false}
  health        text NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy','degraded','down','unknown','not_configured')),
  health_reason text,
  reliability   numeric(5,4),                     -- empirical success rate (null = not enough evidence)
  samples       integer NOT NULL DEFAULT 0,       -- evidence count behind reliability/latency
  latency_p50_ms integer,
  cost_usd_per_use numeric(10,5),
  risk          text NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','high')),
  freshness     text,                             -- how current the underlying data is ('live','snapshot:15s','on-demand')
  authority     integer NOT NULL DEFAULT 50,      -- higher = more authoritative source when sources conflict (R09)
  source        text NOT NULL DEFAULT 'static' CHECK (source IN ('static','discovered','probe')),
  last_probe    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Resource traces for every planned execution (Phase 2F): what was considered, used, skipped, and why.
CREATE TABLE resource_trace (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  interaction_id uuid,
  task_id        uuid,
  request        text NOT NULL,
  capability_id  text NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('used','considered','skipped','unavailable')),
  reason         text NOT NULL,
  relevance      numeric(4,3)
);
CREATE INDEX ix_resource_trace_interaction ON resource_trace (interaction_id);
CREATE INDEX ix_resource_trace_task ON resource_trace (task_id);

GRANT SELECT, INSERT, UPDATE ON capability TO finagai_app;
GRANT SELECT, INSERT ON resource_trace TO finagai_app;
COMMIT;
