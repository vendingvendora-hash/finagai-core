const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function seriesToSvg(pick, title) {
    const W = 1200, H = 700, L = 120, R = 50, T = 90, B = 150;
    const n = pick.values.length;
    const max = Math.max(...pick.values), min = Math.min(0, ...pick.values);
    const pw = W - L - R, ph = H - T - B;
    const x = (i) => L + (n === 1 ? pw / 2 : (i * pw) / (n - 1));
    const y = (v) => T + ph - ((v - min) / ((max - min) || 1)) * ph;
    const titleEl = `<text x="${W / 2}" y="50" font-size="30" font-family="Helvetica" text-anchor="middle" font-weight="bold">${esc(title)}</text>`;
    const grid = Array.from({ length: 5 }, (_, i) => {
        const v = min + ((max - min) * i) / 4;
        const yy = y(v);
        return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#e5e7eb"/><text x="${L - 12}" y="${yy + 5}" font-size="18" text-anchor="end" font-family="Helvetica">${Number(v.toFixed(2)).toLocaleString("en-US")}</text>`;
    }).join("");
    const everyX = Math.ceil(n / 12);
    const xlabels = pick.labels.map((l, i) => (i % everyX === 0 ? `<text x="${x(i)}" y="${T + ph + 30}" font-size="16" text-anchor="middle" font-family="Helvetica" transform="rotate(35 ${x(i)} ${T + ph + 30})">${esc(String(l).slice(0, 16))}</text>` : "")).join("");
    const axisTitles = `<text x="${W / 2}" y="${H - 15}" font-size="18" text-anchor="middle" font-family="Helvetica">${esc(pick.labelColumn)}</text>` +
        `<text x="30" y="${T + ph / 2}" font-size="18" text-anchor="middle" font-family="Helvetica" transform="rotate(-90 30 ${T + ph / 2})">${esc(pick.valueColumn)}</text>`;
    let body = "";
    if (pick.isTimeLike && n >= 2) {
        const pts = pick.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
        body += `<polyline fill="none" stroke="#2563eb" stroke-width="3" points="${pts}"/>`;
        body += pick.values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#2563eb"/>`).join("");
        // least-squares trendline
        const xs = pick.values.map((_, i) => i);
        const mx = xs.reduce((a, b) => a + b, 0) / n, my = pick.values.reduce((a, b) => a + b, 0) / n;
        const slope = xs.reduce((a, xi, i) => a + (xi - mx) * (pick.values[i] - my), 0) / (xs.reduce((a, xi) => a + (xi - mx) ** 2, 0) || 1);
        const intercept = my - slope * mx;
        body += `<line x1="${x(0)}" y1="${y(intercept)}" x2="${x(n - 1)}" y2="${y(intercept + slope * (n - 1))}" stroke="#ef4444" stroke-width="2.5" stroke-dasharray="8 5"/>`;
        body += `<text x="${W - R}" y="${T + 20}" font-size="16" text-anchor="end" font-family="Helvetica" fill="#ef4444">trend: ${slope >= 0 ? "▲" : "▼"} ${Math.abs(slope).toFixed(2)}/step</text>`;
    }
    else {
        const bw = (pw / n) * 0.7;
        body += pick.values.map((v, i) => `<rect x="${x(i) - bw / 2}" y="${Math.min(y(v), y(0))}" width="${bw}" height="${Math.abs(y(0) - y(v))}" fill="#2563eb"/>`).join("");
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>${titleEl}${grid}${body}${xlabels}${axisTitles}</svg>`;
}
//# sourceMappingURL=chart.js.map