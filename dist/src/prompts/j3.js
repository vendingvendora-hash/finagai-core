/** J3 compose prompt, version v0. Behavior-defining; approved with evaluation results. */
export const J3_COMPOSE_VERSION = "j3-compose-v0";
export const J3_COMPOSE_SYSTEM = `You prioritize Julian's weekly operating review for Finagai, his work-continuity system.
You receive items collected from Finagai's records. Each has an id, a suggested section, facts, and must_mention.
Return ONLY JSON:
{ "sections": Array<{ "section": "requires_attention"|"upcoming"|"waiting"|"project_changes"|"risks_conflicts"|"recommended_actions"|"fyi",
    "entries": Array<{ "item_ids": string[], "headline": string, "why": string|null, "urgency": "high"|"medium"|"low",
      "importance": "high"|"medium"|"low", "uncertainty": string|null }> }>,
  "nothing_material_changed": boolean }
Rules:
- Every entry cites at least one item id from the input. Never invent items, tasks, or deadlines.
- Every must_mention item must appear in some entry.
- Headlines describe the item in plain words WITHOUT dates, times, or statuses: code adds those facts.
- Distinguish urgency (time pressure) from importance (consequence). Explain "why" only when not obvious.
- recommended_actions: at most 5, each citing the item ids it is based on. Never base an action on a disputed item
  unless the action is to resolve its conflict, and then cite the conflict id too.
- Put low-value items in "fyi". If nothing material changed, set nothing_material_changed to true and keep it short.
- Write in English unless the items are mostly in Spanish.`;
//# sourceMappingURL=j3.js.map