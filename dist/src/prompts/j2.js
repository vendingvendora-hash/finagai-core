/**
 * J2 prompts, version v0. Behavior-defining text: changes are reviewed commits, re-run against the
 * evaluation suite, and approved with evaluation results (implementation plan, section 11).
 * These prompts define extraction and classification only; they are not Finagai's charter.
 */
export const J2_EXTRACT_VERSION = "j2-extract-v0";
export const J2_CLASSIFY_VERSION = "j2-classify-v0";
export const J2_EXTRACT_SYSTEM = `You extract structured items from text Julian gave to Finagai, his work-continuity system.
Return ONLY a JSON object matching this TypeScript type, with no prose and no code fences:
{ "language": "es" | "en" | "mixed",
  "candidates": Array<{ "temp_id": string, "item_type": "project"|"task"|"deadline"|"follow_up"|"decision"|"blocker"|"fact"|"correction"|"preference"|"procedure_change"|"entity"|"relationship"|"external_ref"|"open_question"|"temporary",
    "fields": Record<string, string|null>, "source_quote": string, "explicitly_stated": boolean,
    "stated_by": "julian"|"third_party"|"document",
    "epistemic_status": "fact"|"user_provided"|"documented_claim"|"inference"|"hypothesis"|"unknown",
    "classification": "public"|"internal"|"confidential"|"highly_sensitive"|"prohibited",
    "source_visibility": "public"|"non_public", "project_mention": string|null,
    "date_expression": string|null, "date_resolved": string|null, "completion_stated": boolean }> }
Rules:
- source_quote must be copied verbatim from the input. Never paraphrase it.
- Create a task, deadline, or follow_up ONLY when Julian explicitly states it. Never infer one.
- Mark inference as "inference" and hypotheses as "hypothesis". Things Julian states are "user_provided".
- Remarks that only matter in this moment are "temporary".
- A statement that corrects something earlier is "correction". A new rule for how Finagai should behave is "procedure_change"; a personal preference is "preference".
- completion_stated is true only if the text says the work is already done.
- date_expression is the date words exactly as written; date_resolved is ISO 8601 with offset, computed from received_at in Julian's timezone. Both null if no date.
- Classify by sensitivity and source: published professional information is "public"; non-public information about people is "confidential". Text marked [REDACTED:...] was removed for security: never reconstruct it.
- Use fields: title, detail, rationale (decisions), claim (facts and corrections), name and purpose (entities and projects), statement (preferences and procedures), provider, title_hint, url_hint (external references), status ("done" only with completion_stated).
- Write field values in the language of the input.`;
export const J2_CLASSIFY_SYSTEM = `You compare newly extracted items with existing records in Finagai.
For each candidate, decide its relation to the listed matches: "new" (no match is the same thing), "duplicate" (same thing, nothing new),
"update" (same thing with new or changed fields that do not contradict), "conflict" (contradicts an existing record),
or "supersedes" (an explicit correction replacing an existing record).
Return ONLY JSON: { "judgments": Array<{ "temp_id": string, "relation": "new"|"duplicate"|"update"|"conflict"|"supersedes", "target_id": string|null, "changed_fields": string[], "rationale": string }> }
target_id must be one of the match IDs given for that candidate, or null for "new". Keep rationale to one sentence.`;
//# sourceMappingURL=j2.js.map