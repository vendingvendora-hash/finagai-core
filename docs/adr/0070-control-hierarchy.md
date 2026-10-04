# ADR-070 — Control hierarchy, AX-first actions, observe→act→verify (WO4/WO8)
**Decided by:** Julian ("do not force everything through one LLM mouse-click loop")

Before: the general operator's only write actions were click(x,y)/type/key/scroll/open_*; success was assumed
from the click. Now:
- `helper/mac-actions.mjs`: activate_app, menu_item, ax_click (by accessibility title/role), ax_set_value
  (read-back verified), observe. Every action returns verified / unverified / error with the before→after
  app/window/focus delta; "unverified" is treated as NOT done by the planner instruction.
- `src/mac/router.ts`: deterministic, health-aware ladder per request domain (parser → scripting → DOM → AX →
  perception → mouse); rungs whose capability probe failed are skipped and the reason says so. The route is
  injected into every planner prompt and returned by control_mac.
- Benchmark: across 8 representative requests visual_mouse is primary for none; browser-down and
  accessibility-down scenarios reroute correctly. Action contract tested with an injected osa.
