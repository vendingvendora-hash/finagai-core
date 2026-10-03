-- 0016_areas_of_responsibility.sql
-- Employee-level layer (product mandate): first-class Areas of Responsibility, Objectives, Follow-ups
-- (closed-loop), and Area health. Linked to the existing project model, NOT overloading it. Backward
-- compatible: projects keep working untouched; a project MAY belong to an area.
-- 'cos' (chief-of-staff / employee layer) is a new event actor; ALTER TYPE ADD VALUE can't run in a txn.
SET search_path = finagai, public;
ALTER TYPE event_actor ADD VALUE IF NOT EXISTS 'cos';

BEGIN;
SET search_path = finagai, public;

-- A persistent domain Finagai continuously manages (Career, Vendora, Personal Admin, Financial work).
CREATE TABLE area (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,                        -- areas are long-lived; archive instead of delete
  version         integer NOT NULL DEFAULT 1,
  last_event_id   bigint REFERENCES event (id),
  name            text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  policy          jsonb NOT NULL DEFAULT '{}'::jsonb, -- operating expectations / service levels (configurable)
  classification  classification_level NOT NULL DEFAULT 'internal',
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))) STORED,
  CONSTRAINT ck_area_not_prohibited CHECK (classification <> 'prohibited')
);
CREATE UNIQUE INDEX uq_area_name_active ON area (lower(name)) WHERE archived_at IS NULL;

-- A desired outcome within an Area (e.g. "secure a strong finance role").
CREATE TABLE objective (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  area_id       uuid NOT NULL REFERENCES area (id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','achieved','abandoned','paused')),
  target_date   date,
  last_event_id bigint REFERENCES event (id)
);
CREATE INDEX ix_objective_area ON objective (area_id) WHERE status = 'open';

-- Link existing projects to an area (nullable; existing projects keep working with no area).
ALTER TABLE project ADD COLUMN area_id uuid REFERENCES area (id) ON DELETE SET NULL;
ALTER TABLE project ADD COLUMN objective_id uuid REFERENCES objective (id) ON DELETE SET NULL;
CREATE INDEX ix_project_area ON project (area_id) WHERE area_id IS NOT NULL;

-- Closed-loop follow-ups: a commitment Finagai must see through (sent -> waiting -> overdue -> closed).
CREATE TABLE followup (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  area_id        uuid REFERENCES area (id) ON DELETE SET NULL,
  project_id     uuid REFERENCES project (id) ON DELETE SET NULL,
  summary        text NOT NULL,                       -- "follow up with Beth about the pricing analyst role"
  counterparty   text,                                -- who we're waiting on (person/org), free text
  channel        text,                                -- email / imessage / call / form ...
  state          text NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','waiting','overdue','done','cancelled')),
  due_at         timestamptz,                         -- when a response/next action is expected
  last_action_at timestamptz,                         -- when we last did something on it
  closed_at      timestamptz,
  outcome        text,                                -- how it resolved (for institutional memory)
  last_event_id  bigint REFERENCES event (id),
  CONSTRAINT ck_followup_closed CHECK ((state IN ('done','cancelled')) = (closed_at IS NOT NULL))
);
CREATE INDEX ix_followup_open ON followup (due_at) WHERE state IN ('open','waiting','overdue');
CREATE INDEX ix_followup_area ON followup (area_id) WHERE state NOT IN ('done','cancelled');

-- Least-privilege grants for the running service (matches 0003: SELECT/INSERT/UPDATE, no DELETE).
GRANT SELECT, INSERT, UPDATE ON area, objective, followup TO finagai_app;

COMMIT;
