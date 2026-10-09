// Builds browser-ext/build/{chrome,firefox} from src + per-browser manifest. No bundler; plain copies.
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
for (const b of ["chrome", "firefox"]) {
  const out = join(here, "build", b);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  copyFileSync(join(here, `manifest.${b}.json`), join(out, "manifest.json"));
  for (const f of ["background.js", "content.js"]) copyFileSync(join(here, "src", f), join(out, f));
}
console.log("built browser-ext/build/{chrome,firefox}");
