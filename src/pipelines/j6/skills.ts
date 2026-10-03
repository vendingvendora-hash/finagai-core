/**
 * J6 skill playbooks (ADR-055). Encoded know-how the planner is given based on what the task looks like.
 * This is where "state of the art" lives in practice: reliable procedures, not just a bigger model.
 */
export interface Skill { name: string; when: RegExp; play: string }

export const SKILLS: Skill[] = [
  {
    name: "find-in-drive",
    when: /\b(drive|carpeta|folder|documento|document|archivo|file|licencia|license|pdf|good standing|compliance)\b/i,
    play: `FIND A FILE IN GOOGLE DRIVE:
- Julian may have several Google accounts in Chrome. Drive numbers them: /u/0/, /u/1/, /u/2/ ...
- Go straight to search, do not click through folders: open_url https://drive.google.com/drive/u/0/search?q=<terms> (URL-encode). If no results, try /u/1/ then /u/2/ with the same query.
- Vendora's files live in a separate Vendora Google account — if the personal account (/u/0/) has nothing, switch to the other account's Drive by changing the /u/N/ number BEFORE asking Julian.
- When you see the file in results, open it (open_url its link or click it once), let it load, then screenshot to read/send it.
- Only ask Julian if every account's Drive search returns nothing.`,
  },
  {
    name: "read-gmail",
    when: /\b(email|correo|gmail|mail|mensaje de|confirmation|confirmaci[oó]n|recibo|receipt|invoice|factura)\b/i,
    play: `READ GMAIL:
- open_url https://mail.google.com/mail/u/0/#search/<terms> (URL-encode). Try /u/1/ etc. if the first account has nothing.
- Open the matching thread, let it load, screenshot to read it. Never send or reply unless Julian's task says to.`,
  },
  {
    name: "fill-a-form",
    when: /\b(form|formulario|apply|aplicar|application|registrar|sign ?up|checkout|rellenar|fill)\b/i,
    play: `FILL A FORM:
- Click each field, then type its value. Tab or click to move between fields.
- Stop and ask Julian for anything you don't have or shouldn't guess (passwords, payment details, personal IDs).
- Do NOT click the final submit/pay/confirm button on your own — that step needs Julian's approval.`,
  },
  {
    name: "make-a-doc",
    when: /\b(doc|documento|deck|slides|presentaci[oó]n|presentation|sheet|hoja|spreadsheet|write up|draft a)\b/i,
    play: `CREATE A DOCUMENT:
- Prefer the app Julian already uses (Google Docs/Sheets/Slides in the browser, or Pages/Numbers/Keynote).
- Build the content step by step; save to the place Julian asked. Saving/downloading is fine; sending it to someone needs approval.`,
  },
];

/** The playbooks whose triggers match the request, joined for the system prompt. */
export function skillsFor(request: string): string {
  const hits = SKILLS.filter((s) => s.when.test(request)).map((s) => s.play);
  return hits.length ? `\nRelevant playbooks:\n${hits.join("\n\n")}` : "";
}
