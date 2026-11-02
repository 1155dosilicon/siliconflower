import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

// Electron loads CommonJS here: the sandboxed preload cannot use ES modules.
const root = import.meta.dir;
const out = join(root, "build");
rmSync(out, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "main.ts"), join(root, "src", "preload.ts")],
  outdir: out,
  target: "node",
  format: "cjs",
  naming: "[name].cjs",
  external: ["electron"],
});
if (!result.success) {
  for (const entry of result.logs) console.error(entry);
  process.exit(1);
}
cpSync(join(root, "src", "renderer"), join(out, "renderer"), { recursive: true });
