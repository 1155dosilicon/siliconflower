#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "index.tsx");

function findRunner() {
  // Prefer bun (runs TSX natively), fall back to tsx, then npx tsx.
  const order = [
    ["bun", ["run", entry]],
    ["tsx", [entry]],
    ["npx", ["tsx", entry]],
  ];
  for (const [cmd, args] of order) {
    const probe = spawnSync(cmd, ["--version"], { shell: true, stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      return [cmd, args];
    }
  }
  return ["npx", ["tsx", entry]];
}

const [cmd, args] = findRunner();
const result = spawnSync(cmd, [...args, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

if (result.error) {
  if ((result.error).code === "ENOENT") {
    process.stderr.write(
      "\nsiliconflower requires Bun or Node + tsx.\nInstall Bun: https://bun.sh  or run:  npm install\n"
    );
  } else {
    process.stderr.write(String(result.error));
  }
  process.exit(1);
}
process.exit(result.status ?? 0);
