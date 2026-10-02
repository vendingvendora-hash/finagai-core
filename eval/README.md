# Evaluation suite

- `cases/`: 20 baseline cases (T01-T20) and adversarial cases E01-E03, one YAML file each.
- `runner/`: creates an isolated Neon branch per run, loads fixtures, runs the pipeline, asserts on database state.
- `graders/`: deterministic assertions plus the Opus rubric grader for J3 cases.
- `reports/`: committed results per run.

Pass bar for v1 acceptance (A1): zero unacceptable-class failures across 3 repetitions of every case.
AR07 capture-reliability audits are recorded in `finagai.capture_audit`, not here.
