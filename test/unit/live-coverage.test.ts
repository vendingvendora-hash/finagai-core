/**
 * ADR-087 (hotfix 34) — the structural guard: no write path may change authoritative state without a semantic event.
 *
 * Live defect it closes: on 2026-10-12 a real "application viewed" email rescheduled a follow-up and added job history
 * with no event of their own — the change existed only as prose inside workflow_completed. The rules, over every SQL
 * write in src (parsed with the TypeScript compiler, not grepped):
 *   1. every table written is classified — STATE (evented) or OPERATIONAL (with a reason) — in src/db/state-events.ts;
 *      a new table fails here until someone decides which it is;
 *   2. the event log is written only by appendEvent() (no raw INSERT INTO event);
 *   3. a write that changes a STATE table's semantic columns must emit an event about that kind of object in the SAME
 *      block (appendEvent with that entityType, recordTransition/recordBulkTransitions on that table, or a local helper
 *      that does) — "the workflow evented something else nearby" does not count;
 *   4. the few writes whose event is deliberately elsewhere are listed in EXEMPT with the reason, and an exemption that
 *      no longer matches a write fails (so the list cannot rot).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { OPERATIONAL_TABLES, STATE_TABLES } from "../../src/db/state-events.js";
import { STATE_ENTITY_TYPES } from "../../src/db/events.js";

const SRC = resolve(__dirname, "../../src");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });

/** Writes whose semantic event is deliberately emitted elsewhere. key = "file:function:table" → why. */
const EXEMPT: Record<string, string> = {
  "backup/backup.ts:restoreBackup:<dynamic>": "restoring a backup copies every table verbatim, including the original events",
};

interface Write { file: string; line: number; fn: string; op: string; table: string; semantic: boolean; evented: boolean; sql: string }

function scan(): Write[] {
  const out: Write[] = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, "utf8");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    // functions in this file that emit events (appendEvent / recordTransition / recordBulkTransitions in their body)
    const emitters = new Set<string>(["recordTransition", "recordBulkTransitions"]);
    const findEmitters = (n: ts.Node) => {
      let name: string | null = null; let body: ts.Node | null = null;
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && n.body) { name = n.name.getText(sf); body = n.body; }
      if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) { name = n.name.getText(sf); body = n.initializer; }
      if (name && body && /\b(appendEvent|recordTransition|recordBulkTransitions)\(/.test(body.getText(sf))) emitters.add(name);
      ts.forEachChild(n, findEmitters);
    };
    findEmitters(sf);
    const visit = (node: ts.Node, fns: ts.Node[]) => {
      const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
      const stack = isFn ? [...fns, node] : fns;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const sql = node.getText(sf);
        for (const m of sql.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+(?:[a-z_]+\.)?([a-z_]+)\b([\s\S]*)/g)) {
          if (m[1] === "UPDATE" && !/^\s*(?:[a-z_]+\s+)?SET\b/i.test(m[3]!)) continue;                 // "DO UPDATE" etc. are not table writes
          const table = sql.slice((m.index ?? 0) + m[0].length - m[3]!.length).startsWith(".${") ? "<dynamic>" : m[2]!;
          const st = STATE_TABLES[table];
          let semantic = !!st || table === "<dynamic>";
          if (st && m[1] === "UPDATE") {
            const set = /SET([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|\bFROM\b|$)/i.exec(m[3]!)?.[1] ?? "";
            semantic = [...set.matchAll(/([a-z_]+)\s*=/g)].some((c) => st.semantic.includes(c[1]!));
          }
          let b: ts.Node | undefined = node; while (b && !ts.isBlock(b) && !ts.isSourceFile(b)) b = b.parent;
          const block = (b ?? sf).getText(sf);
          const want = st ? new Set([st.entity, table]) : new Set<string>();
          const direct = [...block.matchAll(/appendEvent\((?=([\s\S]{0,400}))/g)].some((c) => { const et = /entityType:\s*(?:"([a-z_]+)"|([A-Za-z_.]+))/.exec(c[1]!); return !!et && (et[1] ? want.has(et[1]) : true); });
          const viaTransition = [...block.matchAll(/record(?:Bulk)?Transitions?\((?=([\s\S]{0,400}))/g)].some((c) => { const t = /table:\s*(?:"([a-z_]+)"|([A-Za-z_]))/.exec(c[1]!); return !!t && (t[1] ? t[1] === table : true); });
          const viaHelper = [...emitters].filter((e) => !["recordTransition", "recordBulkTransitions"].includes(e)).some((e) => new RegExp(`\\b${e}\\(`).test(block));
          const named = [...stack].reverse().find((n) => (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) as ts.FunctionDeclaration | undefined;
          out.push({ file: relative(SRC, f), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, fn: named?.name?.getText(sf) ?? "<anon>", op: m[1]!, table, semantic,
            evented: direct || viaTransition || viaHelper, sql: sql.replace(/\s+/g, " ").slice(0, 120) });
        }
      }
      ts.forEachChild(node, (c) => visit(c, stack));
    };
    visit(sf, []);
  }
  return out;
}

const writes = scan();
const exemptKey = (w: Write) => [`${w.file}:${w.fn}:${w.table}`, `${w.file}:${w.fn}:*`].find((k) => k in EXEMPT);

describe("ADR-087 coverage guard: authoritative state never changes without a semantic event", () => {
  it("finds the writes (sanity: the scanner sees the codebase)", () => {
    expect(writes.length).toBeGreaterThan(200);
    expect(writes.some((w) => w.table === "followup" && w.op === "UPDATE")).toBe(true);
  });
  it("every table Finagai writes is classified as state (evented) or operational (with a reason)", () => {
    const unknown = [...new Set(writes.map((w) => w.table).filter((t) => t !== "<dynamic>" && !STATE_TABLES[t] && !(t in OPERATIONAL_TABLES)))];
    expect(unknown).toEqual([]);
  });
  it("every state table's events are recognised as state changes (so they always cite a cause)", () => {
    expect(Object.values(STATE_TABLES).map((t) => t.entity).filter((e) => !STATE_ENTITY_TYPES.has(e))).toEqual([]);
  });
  it("the event log is written only by appendEvent()", () => {
    expect(writes.filter((w) => w.table === "event" && w.op === "INSERT INTO" && w.file !== "db/events.ts").map((w) => `${w.file}:${w.line}`)).toEqual([]);
  });
  it("every write that changes state emits an event about that object in the same block", () => {
    const silent = writes.filter((w) => w.semantic && !w.evented && !exemptKey(w)).map((w) => `${w.file}:${w.line} ${w.fn} ${w.op} ${w.table} :: ${w.sql}`);
    expect(silent).toEqual([]);
  });
  it("every exemption still matches a write (the list cannot rot)", () => {
    const used = new Set(writes.map(exemptKey).filter(Boolean));
    expect(Object.keys(EXEMPT).filter((k) => !used.has(k))).toEqual([]);
  });
  it("the three live bypass paths are now evented (regression for the Vantage case)", () => {
    const at = (file: string, table: string, fn: string) => writes.filter((w) => w.file === file && w.table === table && w.fn === fn && w.semantic);
    expect(at("cos/opportunities.ts", "followup", "reconcileJob").every((w) => w.evented)).toBe(true);           // reschedule / link / close
    expect(at("cos/career-sync.ts", "opportunity_event", "syncCareer").every((w) => w.evented)).toBe(true);      // new job history
    expect(at("cos/followups.ts", "followup", "sweepOverdue").every((w) => w.evented)).toBe(true);              // overdue flip
    expect(at("cos/opportunities.ts", "followup", "reconcileJob").length).toBeGreaterThanOrEqual(3);
  });
});
