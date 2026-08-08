import { existsSync, mkdirSync, rmSync, readdirSync, renameSync, statSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build script: produces a standalone siliconflower.exe via `bun build --compile`.
 *
 * Usage:
 *   bun run build                # -> dist/siliconflower.exe (Windows x64)
 *
 * Notes:
 *  - `react-devtools-core` is an optional peer of `ink`. It is only used by Ink
 *    when `DEV=true`, but Bun statically resolves its top-level import and would
 *    either fail the build ("Could not resolve") or fail at runtime inside the
 *    compiled binary ("Cannot find package"). We shim it to a no-op module so the
 *    bundle resolves cleanly without pulling in the real (heavy) devtools package.
 *  - `bun build --compile` embeds the Bun runtime + all JS into a single binary.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const outDir = join(root, "dist");

const REACT_DEVTOOLS_SHIM = `
const devtools = { connectToDevTools() {} };
export default devtools;
export function connectToDevTools() {}
`;

const shimPlugin = {
  name: "optional-deps-shim",
  setup(build) {
    // react-devtools-core -> no-op shim
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "sf-shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "sf-shim" }, (args) => {
      if (args.path === "react-devtools-core") {
        return { contents: REACT_DEVTOOLS_SHIM, loader: "js" };
      }
      return undefined;
    });
  },
};

// Clean previous output
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Skills are embedded in the binary via EMBEDDED_SKILLS in skills.ts
// No need to copy skills/ directory to dist/

const result = await Bun.build({
  entrypoints: [join(root, "src", "index.tsx")],
  outdir: outDir,
  target: "bun-windows-x64",
  compile: true,
  minify: true,
  sourcemap: "external",
  plugins: [shimPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// `bun build --compile` names the binary after the entrypoint (e.g. `src.exe`
// for `src/index.tsx`). We rename it to the canonical `siliconflower.exe`.
const produced = readdirSync(outDir)
  .filter((f) => f.endsWith(".exe"))
  .map((f) => {
    const p = join(outDir, f);
    return { f, p, size: statSync(p).size };
  })
  .sort((a, b) => b.size - a.size)[0];

if (!produced) {
  console.error("Nenhum binário .exe foi gerado em:", outDir);
  console.error("Conteúdo:", readdirSync(outDir));
  process.exit(1);
}

if (produced.f !== "siliconflower.exe") {
  const target = join(outDir, "siliconflower.exe");
  rmSync(target, { force: true });
  renameSync(produced.p, target);
}

const finalPath = join(outDir, "siliconflower.exe");
if (!existsSync(finalPath)) {
  console.error("Binário final não encontrado:", finalPath);
  process.exit(1);
}

const sizeMB = (statSync(finalPath).size / (1024 * 1024)).toFixed(1);
console.log(`\n[ok] binário gerado: ${finalPath} (${sizeMB} MB)`);
