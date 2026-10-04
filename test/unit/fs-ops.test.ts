/** Phase 1B — verified file operations on a real filesystem (temp dirs). */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveFileVerified, trashVerified, findInTrash } from "../../helper/fs-ops.mjs";

let d: string;
beforeEach(() => { d = mkdtempSync(join(tmpdir(), "fsops-")); });

describe("moveFileVerified", () => {
  it("moves and verifies destination, size, hash, source gone", async () => {
    writeFileSync(join(d, "a.txt"), "hello finagai");
    const r = await moveFileVerified(join(d, "a.txt"), join(d, "b.txt"));
    expect(r.ok).toBe(true); expect(r.verdict).toBe("verified"); expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(d, "a.txt"))).toBe(false); expect(existsSync(join(d, "b.txt"))).toBe(true);
  });
  it("refuses a collision unless overwrite is explicit", async () => {
    writeFileSync(join(d, "a.txt"), "new"); writeFileSync(join(d, "b.txt"), "old");
    const r = await moveFileVerified(join(d, "a.txt"), join(d, "b.txt"));
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/collision/); expect(existsSync(join(d, "a.txt"))).toBe(true);
    const r2 = await moveFileVerified(join(d, "a.txt"), join(d, "b.txt"), { overwrite: true });
    expect(r2.ok).toBe(true);
  });
  it("moving into a folder keeps the name (Finder semantics)", async () => {
    writeFileSync(join(d, "a.txt"), "x"); mkdirSync(join(d, "dir"));
    const r = await moveFileVerified(join(d, "a.txt"), join(d, "dir"));
    expect(r.ok).toBe(true); expect(r.dest).toBe(join(d, "dir", "a.txt"));
  });
  it("missing source, missing destination folder, symlink and directory sources are errors (no false success)", async () => {
    expect((await moveFileVerified(join(d, "nope"), join(d, "b"))).ok).toBe(false);
    writeFileSync(join(d, "a.txt"), "x");
    expect((await moveFileVerified(join(d, "a.txt"), join(d, "no-such-dir", "b.txt"))).reason).toMatch(/destination folder does not exist/);
    symlinkSync(join(d, "a.txt"), join(d, "link"));
    expect((await moveFileVerified(join(d, "link"), join(d, "c"))).reason).toMatch(/symbolic link/);
    mkdirSync(join(d, "folder"));
    expect((await moveFileVerified(join(d, "folder"), join(d, "f2"))).reason).toMatch(/not a regular file/);
  });
  it("cross-volume path: copy→verify→rename, no partial file left; a corrupted copy is rejected and the source kept", async () => {
    writeFileSync(join(d, "a.txt"), "cross volume content");
    const exdev = Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    const { copyFile } = await import("node:fs/promises");
    const ok = await moveFileVerified(join(d, "a.txt"), join(d, "b.txt"), { fsImpl: { rename: async () => { throw exdev; }, copyFile } });
    expect(ok.ok).toBe(true); expect(ok.method).toBe("copy-verify-rename");
    expect(readdirSync(d).filter((f) => f.includes("partial"))).toEqual([]);
    writeFileSync(join(d, "c.txt"), "original");
    const bad = await moveFileVerified(join(d, "c.txt"), join(d, "e.txt"), { fsImpl: { rename: async () => { throw exdev; }, copyFile: async (_s: string, t: string) => writeFileSync(t, "corrupt!") } });
    expect(bad.ok).toBe(false); expect(existsSync(join(d, "c.txt"))).toBe(true); expect(existsSync(join(d, "e.txt"))).toBe(false);
    expect(readdirSync(d).filter((f) => f.includes("partial"))).toEqual([]);
  });
});

describe("trashVerified", () => {
  it("verified only when the source is gone AND a matching new item appears in the Trash", async () => {
    const trash = join(d, ".Trash"); mkdirSync(trash); writeFileSync(join(d, "r.pdf"), "x");
    const { renameSync } = await import("node:fs");
    const ok = await trashVerified(join(d, "r.pdf"), { trashDir: trash, trashFn: async (p: string) => renameSync(p, join(trash, "r 2.pdf")) });
    expect(ok.ok).toBe(true); expect(ok.reason).toMatch(/r 2\.pdf/);
    writeFileSync(join(d, "s.pdf"), "x");
    const { rmSync } = await import("node:fs");
    const deleted = await trashVerified(join(d, "s.pdf"), { trashDir: trash, trashFn: async (p: string) => rmSync(p) });
    expect(deleted.ok).toBe(false); expect(deleted.reason).toMatch(/deleted, not trashed/);
    expect(await findInTrash(trash, "r.pdf")).toBe("r 2.pdf");
  });
});
