-- 0031_event_engine.sql
-- Phase 5 (ADR-084): event-driven proactivity. External events (new mail, calendar changes, source-sheet edits) and
-- approaching/passed deadlines are recorded once (idempotent by source + external id), routed to the Area workflow
-- that subscribes to them, handled, and — only when Julian's judgment, authorization or a principal-reserved action is
-- genuinely required — escalated to him once. Every tick, event, routing decision and escalation is recorded.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE event_cursor (
  watcher     text NOT NULL,                 -- e.g. 'gmail', 'calendar', 'sheet:career', 'deadlines'
  scope       text NOT NULL DEFAULT '',      -- e.g. the Google account
  cursor      text NOT NULL,                 -- watcher-specific position (epoch ms, modifiedTime, …)
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watcher, scope)
);

CREATE TABLE inbound_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at  timestamptz NOT NULL DEFAULT now(),
  occurred_at  timestamptz NOT NULL,
  source       text NOT NULL,                -- 'gmail' | 'calendar' | 'sheet' | 'deadline'
  kind         text NOT NULL,                -- e.g. 'mail.received', 'calendar.upcoming', 'sheet.changed', 'followup.overdue'
  external_id  text NOT NULL,                -- idempotency: the same real-world event is recorded once
  summary      text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new','routed','handled','ignored','failed')),
  routes       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{subscription, area, workflow, why}]
  reason       text,                                 -- why ignored / failed
  attempts     integer NOT NULL DEFAULT 0,           -- workflow attempts (a failed event is retried up to 5 times)
  tick_id      uuid,
  handled_at   timestamptz,
  CONSTRAINT uq_inbound_event UNIQUE (source, external_id)
);
CREATE INDEX ix_inbound_event_status ON inbound_event (status, received_at);
CREATE INDEX ix_inbound_event_received ON inbound_event (received_at DESC);

CREATE TABLE event_tick (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  trigger      text NOT NULL,                -- 'interval' | 'manual' | 'preview'
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','skipped')),
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text
);
CREATE INDEX ix_event_tick_started ON event_tick (started_at DESC);

CREATE TABLE escalation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,         -- deterministic: the same need is escalated once
  created_at   timestamptz NOT NULL DEFAULT now(),
  area_id      uuid REFERENCES area (id) ON DELETE SET NULL,
  needs        text NOT NULL CHECK (needs IN ('judgment','authorization','principal_reserved')),
  summary      text NOT NULL,
  detail       text,
  due_at       timestamptz,
  followup_id  uuid REFERENCES followup (id) ON DELETE SET NULL,
  source_event_ids uuid[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  notified_at  timestamptz,
  resolved_at  timestamptz,
  resolution   text
);
CREATE INDEX ix_escalation_open ON escalation (status, created_at) WHERE status = 'open';

GRANT SELECT, INSERT, UPDATE ON event_cursor, inbound_event, event_tick, escalation TO finagai_app;
COMMIT;
