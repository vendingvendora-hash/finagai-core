export const SKILLS = [
    {
        name: "find-in-drive",
        when: /\b(drive|carpeta|folder|documento|document|archivo|file|licencia|license|pdf|good standing|compliance|contrato|contract)\b/i,
        play: `FIND A FILE IN GOOGLE DRIVE:
- Julian has several Google accounts in Chrome, numbered /u/0/, /u/1/, /u/2/. Vendora's files are in a SEPARATE Vendora account.
- Go straight to search: open_url https://drive.google.com/drive/u/0/search?q=<terms> (URL-encode). If empty, repeat with /u/1/ then /u/2/ BEFORE asking Julian.
- Read the results from the page text. Open the best match, let it load, screenshot it.
- Report back the file name and what it contains. Only ask Julian if every account returns nothing.`,
    },
    {
        name: "read-or-build-spreadsheet",
        when: /\b(excel|xlsx|spreadsheet|hoja de c[aá]lculo|utilization|utilizaci[oó]n|numbers|sheet|csv|data|datos|chart|gr[aá]fico|graph)\b/i,
        play: `READ A SPREADSHEET / GET NUMBERS FOR A CHART:
- If the file is on the Mac: open_path it (or open in the right app) and read the values from the screen; or if it's a .csv/.xlsx you can read as text, use read_file.
- Capture the exact figures (labels, %, targets, categories) as the step result so the chat can chart them.
- If asked to make a chart, gather the numbers first; charts are built in the chat from the data you report. Do not fabricate numbers — read them.`,
    },
    {
        name: "read-gmail",
        when: /\b(email|correo|gmail|mail|mensaje de|confirmation|confirmaci[oó]n|recibo|receipt|invoice|factura|boleto|ticket)\b/i,
        play: `READ GMAIL:
- open_url https://mail.google.com/mail/u/0/#search/<terms> (URL-encode). Try /u/1/ etc. if empty.
- Open the matching thread, let it load, read it from the page text, report the key facts. Never send/reply unless the task says to (and that needs Julian's ok).`,
    },
    {
        name: "calendar",
        when: /\b(calendar|calendario|agenda|schedule|meeting|reuni[oó]n|cita|appointment|evento|event|free time|disponibilidad)\b/i,
        play: `CHECK THE CALENDAR:
- open_url https://calendar.google.com/calendar/u/0/r (or /u/1/). Read events from the page. Report dates, times, titles, locations. Creating/editing an event is a write and needs Julian's ok.`,
    },
    {
        name: "fill-a-form",
        when: /\b(form|formulario|apply|aplicar|application|registrar|sign ?up|checkout|rellenar|fill|workday|greenhouse|lever)\b/i,
        play: `FILL A FORM / JOB APPLICATION:
- Click each field, type its value, Tab or click to the next. Read labels from the page to map fields correctly.
- Use Julian's profile facts you were given; never invent personal data.
- Stop with ask{} for anything you don't have or must not guess (passwords, SSN, payment, 2FA).
- NEVER click the final submit/pay/confirm button yourself — leave it for Julian's approval.`,
    },
    {
        name: "make-a-doc",
        when: /\b(doc|documento|deck|slides|presentaci[oó]n|presentation|memo|carta|letter|draft a|escribe|write a|report|informe)\b/i,
        play: `CREATE A DOCUMENT:
- Use the app Julian uses (Google Docs/Sheets/Slides in the browser, or Pages/Numbers/Keynote).
- Build content step by step; save where Julian asked (saving/downloading is fine). Sending it to someone needs approval.`,
    },
    {
        name: "download-a-file",
        when: /\b(download|descargar|bajar|save the|guarda|export|descarga)\b/i,
        play: `DOWNLOAD / SAVE A FILE:
- From a web page, use its download control; files land in ~/Downloads. Confirm the file appears (list_files ~/Downloads) and report the path. Moving/deleting afterward needs approval.`,
    },
    {
        name: "organize-files",
        when: /\b(organize|organizar|rename|renombrar|mover|move|clean up|ordenar|desktop|escritorio|downloads)\b/i,
        play: `ORGANIZE FILES:
- list_files the folder first, decide the plan, then act. Renaming via Finder or a single run{} command is efficient but run{} and move_file/trash_file each need Julian's ok. Prefer small, reversible moves; never trash without ok.`,
    },
    {
        name: "research-web",
        when: /\b(research|investiga|busca en|look up|precio|price|compare|compara|find out|aver[ií]gua|news|noticias)\b/i,
        play: `RESEARCH ON THE WEB:
- open_url the site or a search URL; read results from the page text; open the best sources; report concrete facts with the source. Confirm fast-changing facts (prices, availability) on the real page.`,
    },
    {
        name: "vendora",
        when: /\b(vendora|compliance|licencia|license|sales and use|tobacco|liquor|venue|bar|vending)\b/i,
        play: `VENDORA CONTEXT:
- Vendora's documents live in a SEPARATE Vendora Google account/Drive — check /u/1/ and /u/2/ Drive, not just the personal /u/0/.
- Licenses/compliance docs are usually PDFs in a compliance folder. Search each account before concluding something is missing.`,
    },
];
/** The playbooks whose triggers match the request, joined for the system prompt (cap to keep the prompt tight). */
export function skillsFor(request) {
    const hits = SKILLS.filter((s) => s.when.test(request)).slice(0, 4).map((s) => s.play);
    return hits.length ? `\nRelevant playbooks:\n${hits.join("\n\n")}` : "";
}
//# sourceMappingURL=skills.js.map