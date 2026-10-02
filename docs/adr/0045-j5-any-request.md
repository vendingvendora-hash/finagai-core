# ADR-045: J5 handles any request, not only tickets

- Status: Accepted (Julian, principal, 2026-10-02: "I want it to handle any request; the ticket was just an example")
- Date: 2026-10-02

## Decision
The J5 concierge (ADR-044) drafts a reply to any message from an allow-listed contact that asks Julian
for something or expects a substantive answer (questions, favors, research, recommendations, plans,
logistics, tickets). It skips messages needing no reply and deeply personal or emotional conversations.

## Unchanged
Every message still waits for Julian's `ok <code>`; replies go only to the requesting contact; Finagai
never buys, books, pays or commits Julian to plans, money or dates he has not stated; spend caps apply.

## Consequences
More drafts (and model spend) per day; most need no web search and cost cents. If drafts become noisy,
narrow the scope or add per-contact auto-send (a separate decision).
