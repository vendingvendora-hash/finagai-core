# Third-party retention policy (ADR-022; defaults proposed in ADR-031)

Required on capture of third-party information: provenance, classification, purpose, project link, and for Confidential information a `retention_review_at` date. Enforced by `ck_entity_confidential_needs_review`, `ck_knowledge_third_party_purpose`, and `ck_knowledge_third_party_retention`.

| Setting | Proposed default | Key |
| --- | --- | --- |
| Confidential third-party review | 180 days after last linked activity; archival eligibility also needs no active linked project | `RETENTION_CONFIDENTIAL_THIRD_PARTY_DAYS` |
| Public professional re-verification | 365 days after `as_of` | `PUBLIC_PROFESSIONAL_REVERIFY_DAYS` |
| Freshness warning at point of use | 120 days | `PUBLIC_FACT_FRESHNESS_WARNING_DAYS` |

Archival happens only through an approved governance request. Nothing is deleted automatically.
