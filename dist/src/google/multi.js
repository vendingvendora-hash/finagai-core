import { GoogleClient } from "./client.js";
export class MultiGoogleClient {
    members;
    constructor(clients) { this.members = clients.map((client) => ({ client, label: null })); }
    static fromConfig(cfg, fetchFn = fetch) {
        const tokens = [...new Set(cfg.refreshTokens.map((t) => t.trim()).filter((t) => t.length >= 10))];
        return new MultiGoogleClient(tokens.map((refreshToken) => new GoogleClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken }, fetchFn)));
    }
    get size() { return this.members.length; }
    async label(m) {
        if (m.label)
            return m.label;
        try {
            m.label = await m.client.account();
        }
        catch {
            return "unverified account";
        }
        return m.label;
    }
    /** Every connected account; a failing token is reported, not hidden (registry shows it). */
    async account() {
        const r = await Promise.allSettled(this.members.map((m) => m.client.account()));
        r.forEach((x, i) => { if (x.status === "fulfilled")
            this.members[i].label = x.value; });
        const ok = r.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
        const bad = r.length - ok.length;
        if (!ok.length) {
            const first = r.find((x) => x.status === "rejected");
            throw new Error(first ? String(first.reason?.message ?? first.reason) : "no Google accounts configured");
        }
        return ok.join(", ") + (bad ? ` (${bad} account(s) failing)` : "");
    }
    async fan(kind, terms) {
        const parts = await Promise.allSettled(this.members.map(async (m) => {
            const rows = await m.client[kind](terms);
            if (this.members.length < 2)
                return rows;
            const acct = await this.label(m);
            return rows.map((x) => ({ ...x, name: `${x.name} [${acct}]` }));
        }));
        const ok = parts.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
        if (!ok.length && parts.every((p) => p.status === "rejected"))
            throw parts[0].reason;
        return ok;
    }
    gmail(terms) { return this.fan("gmail", terms); }
    calendar(terms) { return this.fan("calendar", terms); }
    drive(terms) { return this.fan("drive", terms); }
    async search(terms) {
        const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))].slice(0, 3);
        if (!clean.length)
            return [];
        const parts = await Promise.all([this.drive(clean), this.gmail(clean), this.calendar(clean)].map((p) => p.catch(() => [])));
        return parts.flat();
    }
}
//# sourceMappingURL=multi.js.map