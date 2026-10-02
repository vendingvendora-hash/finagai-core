# Data-classification policy v0 (ADR-016, ADR-020, ADR-021)

Classify by sensitivity and source, not by subject.

| Tier | Definition | v1 handling |
| --- | --- | --- |
| Public | Published or freely available, including public professional information about people | Allowed |
| Internal | Julian's own work state and notes (default) | Allowed |
| Confidential | Non-public information, including non-public information about people | Allowed; never in outbound notifications beyond Julian |
| Highly Sensitive | Serious harm if exposed (full account numbers, government IDs, medical, sensitive legal) | Rejected in v1 at the tool boundary; DB constraint `ck_*_v1_no_highly_sensitive` |
| Prohibited | Raw passwords, API keys, private keys, session and OAuth tokens, other authentication secrets | Never stored, never in model context; DB constraint `ck_*_not_prohibited` |

Enforcement: deterministic detector before storage, model label as second layer, database constraints, output tier filter, and feedback in the capture summary.
