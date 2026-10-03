# ADR-051: Allow-listed contacts may request Mac tasks (Julian still approves)

- Status: Accepted (Julian, principal, 2026-10-02: "I trust them, connect them")
- Date: 2026-10-02

## Decision
J5 triage gains a `do_on_mac` signal. When an allow-listed contact (Santiago, Mom, Denis) messages a
request to actually DO something on the Mac (not just answer), Core opens a J6 control task with
`origin='contact'` and `requester=<label>` (migration 0013). The Mac helper tells Julian who asked and
drives the task through the normal J6 loop.

## Safety (unchanged where it matters)
- Every WRITE step still waits for Julian's "ok <code>" in HIS OWN Messages thread; a contact's messages
  never approve anything. The approval event is attributed to `julian`, verified by test.
- All J6 limits carry over: read steps run freely, `run`/`trash`/`move` and send/pay/delete summaries
  always need an explicit ok, passwords/payments/consent stop for Julian, paths restricted to home.
- When a contact-requested task finishes, Finagai offers the result (and a final screenshot) to Julian
  to forward; it does not message the contact on its own without Julian's approval.

## Consequences
A contact's text can now initiate actions on Julian's Mac. The approval gate is the control: nothing
runs or is sent without Julian. Enabled by the helper sending the "control" capability on sync.
