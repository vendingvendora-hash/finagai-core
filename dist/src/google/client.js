const TEXT_EXPORT = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
};
const MAX_TEXT = 3000;
export class GoogleClient {
    cfg;
    fetchFn;
    token = null;
    refreshing = null;
    constructor(cfg, fetchFn = fetch) {
        this.cfg = cfg;
        this.fetchFn = fetchFn;
    }
    /** One refresh at a time; parallel searches share it. */
    async accessToken() {
        if (this.token && Date.now() < this.token.expires - 60_000)
            return this.token.value;
        this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }
    async refresh() {
        const r = await this.fetchFn("https://oauth2.googleapis.com/token", {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
                refresh_token: this.cfg.refreshToken, grant_type: "refresh_token" }),
        });
        if (!r.ok)
            throw new Error(`google token refresh failed: HTTP ${r.status}`);
        const j = (await r.json());
        this.token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
        return j.access_token;
    }
    async get(url) {
        return this.fetchFn(url, { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(20_000) });
    }
    async json(url) {
        const r = await this.get(url);
        if (!r.ok)
            throw new Error(`google ${new URL(url).hostname} HTTP ${r.status}`);
        return (await r.json());
    }
    /** Drive full-text and name search; Google files exported as text, others listed with a link. */
    async drive(terms) {
        const q = driveQuery(terms);
        const list = await this.json(`https://www.googleapis.com/drive/v3/files?pageSize=6&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(q)}`);
        const out = [];
        for (const f of list.files ?? []) {
            let text = "";
            const exportAs = TEXT_EXPORT[f.mimeType];
            try {
                if (exportAs) {
                    const r = await this.get(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(exportAs)}`);
                    if (r.ok)
                        text = (await r.text()).slice(0, 200_000);
                }
                else if (/^text\/|json|csv/.test(f.mimeType)) {
                    const r = await this.get(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
                    if (r.ok)
                        text = (await r.text()).slice(0, 200_000);
                }
            }
            catch { /* keep the listing */ }
            out.push({ name: `Google Drive: ${f.name}`, path: f.webViewLink ?? `drive:${f.id}`, modified: f.modifiedTime,
                text: `${passageOf(text, terms) || "(no text preview for this file type)"}\nLink: ${f.webViewLink ?? ""}` });
        }
        return out;
    }
    /** Which Google account this client is connected to (registry probe: makes the wrong-account risk visible). */
    async account() {
        const p = await this.json("https://gmail.googleapis.com/gmail/v1/users/me/profile");
        return p.emailAddress ?? "unknown";
    }
    /**
     * Gmail search, ranked (Phase 2D live fix): pull a wider candidate set as metadata, score it — real
     * correspondence and meeting summaries up, newsletters/digests/notifications down — then fetch only the top
     * messages in full. Meeting summaries (e.g. Otter) get a longer excerpt because they carry the substance.
     */
    async gmail(terms, opts = {}) {
        const q = gmailQuery(terms);
        const list = await this.json(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${encodeURIComponent(q)}`);
        const metas = [];
        for (const m of list.messages ?? []) {
            const msg = await this.json(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence`);
            const h = (n) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
            metas.push({ id: m.id, subject: h("subject"), from: h("from"), date: h("date"), internalDate: Number(msg.internalDate),
                bulk: !!h("list-unsubscribe") || /bulk|list/i.test(h("precedence")), snippet: msg.snippet ?? "" });
        }
        const ranked = rankGmail(metas, terms).slice(0, opts.top ?? 8);
        const out = [];
        for (const m of ranked) {
            const msg = await this.json(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
            const summary = isMeetingSummary(m);
            out.push({ name: `Gmail: ${m.subject}`, path: `gmail:${m.id}`, modified: new Date(m.internalDate).toISOString(),
                text: `From: ${m.from}\nDate: ${m.date}\n${summary ? "[meeting summary] " : ""}${passageOf(plainBody(msg.payload) || m.snippet || "", terms, summary ? 4000 : undefined)}` });
        }
        return out;
    }
    /** Calendar events (all calendars on the primary list) matching the terms, 1 year back to 1 year ahead. */
    async calendar(terms) {
        const from = new Date(Date.now() - 365 * 864e5).toISOString();
        const to = new Date(Date.now() + 365 * 864e5).toISOString();
        const lines = [];
        for (const t of terms) {
            const r = await this.json(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=10&timeMin=${from}&timeMax=${to}&q=${encodeURIComponent(t)}`);
            for (const e of r.items ?? [])
                lines.push(`${e.start?.dateTime ?? e.start?.date ?? "?"} | ${e.summary ?? ""} | ${e.location ?? ""}${e.description ? ` | ${e.description.slice(0, 200)}` : ""}`);
        }
        return lines.length ? [{ name: "Google Calendar", path: "google-calendar", text: [...new Set(lines)].slice(0, 20).join("\n") }] : [];
    }
    /** Everything at once; one failing service never blocks the others. */
    async search(terms) {
        const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))].slice(0, 3);
        if (!clean.length)
            return [];
        const parts = await Promise.all([this.drive(clean), this.gmail(clean), this.calendar(clean)].map((p) => p.catch(() => [])));
        return parts.flat();
    }
}
const NOISE_FROM = /(linkedin|noreply|no-reply|newsletter|digest|notifications?@|mailer|marketing|news@)/i;
const NOISE_SUBJECT = /(weekly|digest|newsletter|viewed (by|your)|who('?s| is) viewing|jobs? (for you|alert)|recommended|webinar|unsubscribe)/i;
const SIGNAL_SUBJECT = /(interview|schedul|confirm|panel|next steps?|offer|application|phone screen|call with|meeting|follow[- ]?up|availability|invitation)/i;
export function isMeetingSummary(m) {
    return /otter\.ai|fireflies|fathom|read\.ai|zoom/i.test(m.from) && !/weekly|digest|tips|plan/i.test(m.subject);
}
/** Pure ranking: correspondence about the subject first, meeting summaries kept, notifications pushed down. */
export function rankGmail(metas, terms) {
    const ts = terms.map((t) => t.toLowerCase());
    const score = (m) => {
        let s = 0;
        const subj = m.subject.toLowerCase(), from = m.from.toLowerCase();
        if (ts.some((t) => subj.includes(t)))
            s += 3;
        if (ts.some((t) => from.includes(t.replace(/\s+/g, ""))))
            s += 3; // sender domain/name is the subject (e.g. @altarum.org)
        if (SIGNAL_SUBJECT.test(m.subject))
            s += 3;
        if (isMeetingSummary(m))
            s += 2;
        if (m.bulk)
            s -= 3;
        if (NOISE_FROM.test(m.from) && !isMeetingSummary(m))
            s -= 3;
        if (NOISE_SUBJECT.test(m.subject))
            s -= 4;
        return s;
    };
    return [...metas].map((m) => ({ m, s: score(m) })).filter((x) => x.s > -4)
        .sort((a, b) => b.s - a.s || b.m.internalDate - a.m.internalDate).map((x) => x.m);
}
export function plainBody(p) {
    if (!p)
        return "";
    if (p.mimeType === "text/plain" && p.body?.data)
        return Buffer.from(p.body.data, "base64url").toString("utf8");
    for (const c of p.parts ?? []) {
        const t = plainBody(c);
        if (t)
            return t;
    }
    if (p.mimeType === "text/html" && p.body?.data)
        return Buffer.from(p.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    return "";
}
export function passageOf(text, terms, max = MAX_TEXT) {
    const MAX_TEXT_ = max;
    if (text.length <= MAX_TEXT_)
        return text;
    const lower = text.toLowerCase();
    let at = -1;
    for (const w of terms.flatMap((t) => t.toLowerCase().split(/\s+/)).filter((w) => w.length > 2)) {
        at = lower.indexOf(w);
        if (at >= 0)
            break;
    }
    const start = Math.max(0, at - 1000);
    return text.slice(start, start + MAX_TEXT_);
}
/**
 * ADR-075 live fix: each term is a GROUP — an entity name ("Altarum") or the request's content words
 * ("degree leverage analysis"). Groups are OR'd; words inside a group must ALL match. Previously every word
 * was OR'd, so "analysis" alone pulled unrelated job-history sheets into a Degree-of-Leverage request.
 */
export function driveQuery(groups) {
    const esc = (t) => t.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const one = (g) => {
        const words = g.split(/\s+/).filter(Boolean);
        const byName = words.map((w) => `name contains '${esc(w)}'`).join(" and ");
        // Live fix (R02): full-text AND of several common words ("degree", "leverage", "analysis") matched résumé JSONs.
        // A multi-word subject must be in the file NAME; full text is used for single-word subjects (entities).
        return words.length > 1 ? `(${byName})` : `(fullText contains '${esc(words[0])}' or ${byName})`;
    };
    return `(${groups.map(one).join(" or ")}) and trashed = false`;
}
export function gmailQuery(groups) {
    return groups.map((g) => {
        const words = g.replace(/"/g, "").split(/\s+/).filter(Boolean);
        return words.length === 1 ? `"${words[0]}"` : `(${words.join(" ")})`;
    }).join(" OR ");
}
//# sourceMappingURL=client.js.map