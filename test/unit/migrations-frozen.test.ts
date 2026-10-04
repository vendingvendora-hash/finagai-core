/** Released migrations are immutable: any edit to 0001–0022 fails CI. New changes go in a new file. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
const dir = new URL("../../migrations/", import.meta.url);
const pinned: Record<string, string> = JSON.parse(readFileSync(new URL("CHECKSUMS.json", dir), "utf8"));
describe("migrations are frozen once released", () => {
  for (const [file, sum] of Object.entries(pinned))
    it(`${file} unchanged`, () => { expect(createHash("sha256").update(readFileSync(new URL(file, dir))).digest("hex")).toBe(sum); });
  it("every migration file is pinned (a new file must be added to CHECKSUMS.json when released)", () => {
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(files.filter((f) => !(f in pinned))).toEqual([]);
  });
});
