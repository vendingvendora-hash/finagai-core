/**
 * ADR-087 (hotfix 35) — state-transition events must carry before/after semantics.
 *
 * Gap it closes: after hotfix 34 every state write was evented, but a number of transition paths (governance expiry /
 * supersede / reject, control-task done / cancel, follow-up waiting / done / cancel, escalation resolved, project placed,
 * lesson stated, watch-rule removal, proposal decisions, archives, …) emitted only the new state — an observer could see
 * THAT an object changed, not FROM what. Rules, over every event-emitting call in src (parsed with the TypeScript compiler):
 *   1. every action emitted about a STATE object is classified in EVENT_SEMANTICS (creation / transition / occurrence);
 *      a new action fails here until someone decides what it means;
 *   2. every event about a state object names the object (entityId);
 *   3. a TRANSITION carries `before` (appendEvent / positional emitters) — or is emitted through recordTransition() /
 *      recordBulkTransitions(), which compute the before/after diff from the row;
 *   4. recordTransition() with a literal `before: null` is only for a creation, and occurrences never go through it;
 *   5. actions/entity types that are computed at runtime are listed in DYNAMIC with the reason they are safe (the runtime
 *      acceptance check stateEventQuality covers them on the live stream), and the list cannot rot.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EVENT_SEMANTICS, STATE_TABLES } from "../../src/db/state-events.js";
import { STATE_ENTITY_TYPES } from "../../src/db/events.js";

const SRC = resolve(__dirname, "../../src");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });

/** Emit sites whose action or entity type is computed. key = "file:function" → why it is safe. */
const DYNAMIC: Record<string, string> = {
  "db/state-events.ts:recordTransition": "the generic transition writer itself: always emits a before/after diff",
  "pipelines/j2/capture.ts:applyCandidate": "positional emitter ev(action, entityType, id, after, before?) — its call sites are checked below",
  "db/state-events.ts:recordBulkTransitions": "one recordTransition per returned row, with the row's own before-state",
  "governance/execute.ts:executeGovernanceDecision": "positional emitter ev(action, entityType, id, after, before?) — its call sites are checked below",
  "pipelines/seed/seed.ts:promote": "positional emitter ev(action, entityType, id, after) — its call sites are checked below (creations only)",
};

interface Site { file: string; line: number; fn: string; via: "appendEvent" | "recordTransition" | "recordBulkTransitions" | "positional";
  actions: string[] | null; entityTypes: string[] | null; hasEntityId: boolean; hasBefore: boolean; beforeNull: boolean }

/** Literal values an expression can take: "x" → [x]; c ? "a" : "b" → [a, b]; anything else → null (dynamic). */
function literals(e: ts.Expression | undefined): string[] | null {
  if (!e) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isParenthesizedExpression(e)) return literals(e.expression);
  if (ts.isConditionalExpression(e)) { const a = literals(e.whenTrue), b = literals(e.whenFalse); return a && b ? [...a, ...b] : null; }
  return null;
}

function scan(): Site[] {
  const out: Site[] = [];
  for (const f of files(SRC)) {
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    const file = relative(SRC, f);
    // positional emitters: (action, entityType, entityId, after, before?) => appendEvent(…, { action, entityType, … })
    const positional = new Set<string>();
    const findPositional = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isArrowFunction(n.initializer)) {
        const ps = n.initializer.parameters.map((p) => p.name.getText(sf));
        if (ps[0] === "action" && ps[1] === "entityType" && /appendEvent\(/.test(n.initializer.body.getText(sf))) positional.add(n.name.getText(sf));
      }
      ts.forEachChild(n, findPositional);
    };
    findPositional(sf);
    if (positional.size) positional.add("ev"); // helpers are passed on as `ev: Ev`
    const fnName = (n: ts.Node): string => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText(sf);
        if (ts.isFunctionExpression(p) && p.name) return p.name.getText(sf);
      }
      return "<module>";
    };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        const at = { file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, fn: fnName(n) };
        if (name === "appendEvent" || name === "recordTransition" || name === "recordBulkTransitions") {
          const obj = n.arguments.find((a) => ts.isObjectLiteralExpression(a)) as ts.ObjectLiteralExpression | undefined;
          const prop = (k: string) => obj?.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === k);
          const val = (k: string) => { const p = prop(k); return p && ts.isPropertyAssignment(p) ? p.initializer : undefined; };
          const spreadHas = (k: string) => !!obj?.properties.some((p) => ts.isSpreadAssignment(p) && new RegExp(`\\b${k}\\b`).test(p.getText(sf)));
          const table = literals(val("table"));
          out.push({ ...at, via: name, actions: literals(val("action")),
            entityTypes: name === "appendEvent" ? (prop("entityType") ? literals(val("entityType")) : []) : table ? table.map((t) => STATE_TABLES[t]?.entity ?? `?${t}`) : null,
            hasEntityId: name !== "appendEvent" || !!prop("entityId") || spreadHas("entityId"),
            hasBefore: name !== "appendEvent" || !!prop("before") || spreadHas("before"),
            beforeNull: val("before")?.kind === ts.SyntaxKind.NullKeyword });
        } else if (positional.has(name) && n.arguments.length >= 4) {
          out.push({ ...at, via: "positional", actions: literals(n.arguments[0]), entityTypes: literals(n.arguments[1]),
            hasEntityId: true, hasBefore: n.arguments.length >= 5, beforeNull: false });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const sites = scan();
const key = (s: Site) => `${s.file}:${s.fn}`;
const where = (s: Site) => `${s.file}:${s.line} ${s.via} ${s.actions?.join("|") ?? "<dynamic>"} on ${s.entityTypes?.join("|") ?? "<dynamic>"}`;
/** a site that may be about a state object: a literal state entity type, or one computed at runtime */
const aboutState = (s: Site) => s.entityTypes === null || s.entityTypes.some((t) => STATE_ENTITY_TYPES.has(t));

describe("ADR-087 transition semantics: state-transition events carry before/after", () => {
  it("finds the emit sites (sanity: the scanner sees the codebase)", () => {
    expect(sites.length).toBeGreaterThan(120);
    expect(sites.filter((s) => s.via === "recordTransition").length).toBeGreaterThan(40);
    expect(sites.filter((s) => s.via === "positional").length).toBeGreaterThan(15);
  });

  it("every action emitted about a state object is classified (creation / transition / occurrence)", () => {
    const bad = sites.filter((s) => aboutState(s) && s.actions && s.actions.some((a) => !(a in EVENT_SEMANTICS))).map(where);
    expect(bad).toEqual([]);
  });

  it("an action or entity type computed at runtime is a reviewed exception (and the list cannot rot)", () => {
    const dyn = sites.filter((s) => s.actions === null && (s.entityTypes === null || aboutState(s)));
    expect(dyn.filter((s) => !(key(s) in DYNAMIC)).map(where)).toEqual([]);
    expect(Object.keys(DYNAMIC).filter((k) => !dyn.some((s) => key(s) === k))).toEqual([]);
  });

  it("every event about a state object names the object", () => {
    expect(sites.filter((s) => s.entityTypes?.some((t) => STATE_ENTITY_TYPES.has(t)) && !s.hasEntityId).map(where)).toEqual([]);
  });

  it("every transition carries its before-state (or goes through recordTransition, which diffs the row)", () => {
    const bad = sites.filter((s) => aboutState(s) && s.actions?.some((a) => EVENT_SEMANTICS[a] === "transition") && !s.hasBefore).map(where);
    expect(bad).toEqual([]);
  });

  it("recordTransition with no prior state is a creation; occurrences never pose as transitions", () => {
    expect(sites.filter((s) => s.via === "recordTransition" && s.beforeNull && s.actions?.some((a) => EVENT_SEMANTICS[a] !== "creation")).map(where)).toEqual([]);
    expect(sites.filter((s) => s.via !== "appendEvent" && s.via !== "positional" && s.actions?.some((a) => EVENT_SEMANTICS[a] === "occurrence")).map(where)).toEqual([]);
    expect(sites.filter((s) => s.via === "recordBulkTransitions" && s.actions?.some((a) => EVENT_SEMANTICS[a] !== "transition")).map(where)).toEqual([]);
    expect(sites.filter((s) => s.via === "recordTransition" && s.entityTypes?.some((t) => t.startsWith("?"))).map(where)).toEqual([]);
  });

  it("the paths that lacked a before-state after hotfix 34 are now transitions with one", () => {
    const at = (file: string, action: string) => sites.filter((s) => s.file === file && s.actions?.includes(action));
    for (const [file, action] of [
      ["jobs/maintenance.ts", "governance_expired"], ["governance/execute.ts", "governance_superseded"], ["governance/execute.ts", "governance_rejected"],
      ["pipelines/j6/control.ts", "control_task_done"], ["pipelines/j6/control.ts", "control_task_cancelled"],
      ["cos/followups.ts", "followup_waiting"], ["cos/followups.ts", "followup_done"], ["events/generic.ts", "followup_done"],
      ["events/engine.ts", "escalation_resolved"], ["cos/operating.ts", "project_placed"], ["exceptions/rules.ts", "watch_rule_removed"],
      ["governance/execute.ts", "proposal_decide"], ["governance/execute.ts", "conflict_resolve"], ["governance/execute.ts", "archive"],
      ["governance/execute.ts", "governance_executed"], ["pipelines/j2/capture.ts", "supersede"],
    ] as const) {
      const s = at(file, action);
      expect(s.length, `${file} ${action}`).toBeGreaterThan(0);
      expect(s.every((x) => x.hasBefore && !x.beforeNull), `${file} ${action}`).toBe(true);
    }
  });
});
