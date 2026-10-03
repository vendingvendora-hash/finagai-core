# ADR-055: State-of-the-art reasoning for the J6 agent

- Status: Accepted (Julian, principal, 2026-10-02: "make its thinking sharper, by any means")
- Date: 2026-10-02

## Decision
Upgrade how J6 thinks, without touching the safety gates:
1. Plan-act-reflect loop: each turn the planner first REFLECTS on the previous result (did the screen
   change as expected? why not?), writes a one-line PLAN, then ACTS. Output JSON gains reflection/expect.
2. Extended thinking: the planner runs with a thinking-token budget (J6_THINKING_TOKENS, default 2000).
3. Stronger planner model: MODEL_J6_PLANNER (default claude-opus-5-5) for the planning loop; J5 triage
   stays on the cheaper model.
4. Richer perception: the Mac helper sends the frontmost page's visible text and a list of clickable
   elements (text + center coords) from Chrome, so the planner reads the page instead of guessing pixels.
5. Post-action verification: "expect" records what should happen; the next turn checks it.
6. Skill playbooks (src/pipelines/j6/skills.ts): encoded procedures injected by request type — find-in-
   drive (multi-account /u/N/ search before asking), read-gmail, fill-a-form, make-a-doc.
7. Autonomy: exhaust routes (including other Google accounts) before asking Julian; never repeat a step
   that didn't change the screen.

## Cost / safety
Opus + thinking cost more per planning step; the per-call ceiling and $30/$36 caps (ADR-034) still bound
it, and worst-case estimation now counts thinking tokens. All approval gates (ADR-050/051/054) are
unchanged: reads run free, sending/paying/deleting/running and send-intent still need Julian's ok, and
passwords/payments/consent always stop for him.
