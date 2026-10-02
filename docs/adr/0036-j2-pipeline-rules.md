# ADR-036: J2 pipeline rules added during implementation

- **Date:** 2026-10-01 · **Status:** decided · **Category:** implementation details enforcing approved requirements

1. **G06, overwrite is conflict.** A model "update" may fill a missing field or change status (with G04). If it would replace an existing, different due date it becomes a conflict, and knowledge claims are never updated in place. Found while writing T05: a mislabeled update would otherwise silently overwrite a deadline (an unacceptable error).
2. **G11, dates must be confirmed by code.** A due date is stored only when the code parser (English and Spanish, Julian's timezone) agrees with the model on the calendar day. Mismatched or unparseable dates are not stored; the item is kept and the date is flagged in the capture summary for Julian to confirm. Numeric dates are accepted only when unambiguous for the input's language.
3. **Unsupported in v0:** `relationship` candidates are recorded as rejected with `unsupported_type_v0` and reported, not silently dropped. Open questions are reported in the summary, not stored.
4. **Third-party entities (ADR-022):** rejected with an explicit reason when purpose or project link is missing; Confidential entities get `retention_review_at` from configuration.
5. **Prompts v0** (`src/prompts/j2.ts`) define extraction and classification only; they are versioned and will be approved with real-model evaluation results.
6. **Scripted-model tests** verify pipeline guarantees; model-quality evaluation of T01-T10 requires the real API and follows provisioning.
