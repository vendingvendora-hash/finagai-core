/**
 * Verified file operations (Phase 1B, ADR-072.2). Success is defined by the RESULTING STATE, proportionally:
 * expected destination, file type, size, content hash (when cheap), collision policy, no partial file left,
 * source gone. Moves are atomic renames when possible; cross-volume moves copy to a partial name, verify,
 * then rename into place and remove the source — a crash can never leave a half-written destination.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export const HASH_LIMIT_BYTES = 200 * 1024 * 1024;   // above this, verify size+type only (proportional cost)

async function exists(p) { try { await lstat(p); return true; } catch { return false; } }
export async function sha256(p) {
  return new Promise((res, rej) => { const h = createHash("sha256"); createReadStream(p).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej); });
}

/**
 * @returns {{ok: boolean, verdict: "verified"|"error", reason: string, dest?: string, size?: number, hash?: string|null, method?: string}}
 */
export async function moveFileVerified(src, dest, { overwrite = false, fsImpl = { rename, copyFile } } = {}) {
  if (!(await exists(src))) return { ok: false, verdict: "error", reason: `source does not exist: ${src}` };
  const s = await lstat(src);
  if (s.isSymbolicLink()) return { ok: false, verdict: "error", reason: "refused: source is a symbolic link" };
  if (!s.isFile()) return { ok: false, verdict: "error", reason: "refused: source is not a regular file (folders are moved with a different operation)" };
  // Finder semantics: moving into an existing folder keeps the file name.
  if ((await exists(dest)) && (await stat(dest)).isDirectory()) dest = join(dest, basename(src));
  if (!(await exists(dirname(dest)))) return { ok: false, verdict: "error", reason: `destination folder does not exist: ${dirname(dest)}` };
  if (dest === src) return { ok: false, verdict: "error", reason: "source and destination are the same" };
  if ((await exists(dest)) && !overwrite) return { ok: false, verdict: "error", reason: `collision: ${dest} already exists (not overwritten)` };

  const size = s.size;
  const hash = size <= HASH_LIMIT_BYTES ? await sha256(src) : null;
  let method = "rename";
  try {
    await fsImpl.rename(src, dest);
  } catch (e) {
    if (e?.code !== "EXDEV") return { ok: false, verdict: "error", reason: `move failed: ${String(e?.message ?? e).slice(0, 160)}` };
    method = "copy-verify-rename";
    const partial = join(dirname(dest), `.${basename(dest)}.finagai-partial-${process.pid}`);
    try {
      await fsImpl.copyFile(src, partial);
      const ps = await stat(partial);
      if (ps.size !== size || (hash && (await sha256(partial)) !== hash)) { await rm(partial, { force: true }); return { ok: false, verdict: "error", reason: "copy did not match source (size/hash); destination not written" }; }
      await rename(partial, dest);
      await rm(src);
    } catch (e2) { await rm(partial, { force: true }).catch(() => {}); return { ok: false, verdict: "error", reason: `cross-volume move failed: ${String(e2?.message ?? e2).slice(0, 160)}` }; }
  }
  // VERIFY the resulting state.
  if (!(await exists(dest))) return { ok: false, verdict: "error", reason: "destination missing after move" };
  const ds = await stat(dest);
  if (!ds.isFile()) return { ok: false, verdict: "error", reason: "destination is not a regular file" };
  if (ds.size !== size) return { ok: false, verdict: "error", reason: `size mismatch (${ds.size} != ${size})` };
  if (hash && (await sha256(dest)) !== hash) return { ok: false, verdict: "error", reason: "content hash mismatch" };
  if (await exists(src)) return { ok: false, verdict: "error", reason: "source still present after move" };
  const leftovers = (await readdir(dirname(dest))).filter((f) => f.includes(".finagai-partial-"));
  if (leftovers.length) return { ok: false, verdict: "error", reason: `partial file left behind: ${leftovers[0]}` };
  return { ok: true, verdict: "verified", reason: `moved ${size} bytes${hash ? `, sha256 ${hash.slice(0, 12)}…` : " (size-verified; too large to hash cheaply)"}`, dest, size, hash, method };
}

/** Find the item Finder put in the Trash for `name` (Finder may append " 2" / timestamps on collision). */
export async function findInTrash(trashDir, name) {
  const stem = basename(name, extname(name)), ext = extname(name);
  const items = await readdir(trashDir).catch(() => []);
  return items.find((f) => f === name || (f.startsWith(stem) && f.endsWith(ext))) ?? null;
}

/** Trash with verification: source gone AND a matching item present in ~/.Trash. `trashFn` performs the Finder delete. */
export async function trashVerified(path, { trashDir, trashFn }) {
  if (!(await exists(path))) return { ok: false, verdict: "error", reason: `path does not exist: ${path}` };
  const name = basename(path);
  const before = new Set(await readdir(trashDir).catch(() => []));
  await trashFn(path);
  if (await exists(path)) return { ok: false, verdict: "error", reason: "file still present after trash" };
  const after = await readdir(trashDir).catch(() => null);
  if (after === null) return { ok: true, verdict: "verified", reason: "source removed (Trash not readable to confirm placement)" };
  const added = after.filter((f) => !before.has(f));
  const hit = added.find((f) => f === name || (f.startsWith(basename(name, extname(name))) && f.endsWith(extname(name))));
  return hit ? { ok: true, verdict: "verified", reason: `moved to Trash as ${hit}` } : { ok: false, verdict: "error", reason: "source gone but no matching new item in the Trash (possibly deleted, not trashed)" };
}

export async function ensureDir(p) { await mkdir(p, { recursive: true }); }
