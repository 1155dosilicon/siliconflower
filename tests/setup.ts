import { afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDataDir = join(tmpdir(), `.siliconflower-tests-${process.pid}`);
process.env.SILICONFLOWER_DATA_DIR = testDataDir;

// Ink (via is-in-ci) draws only the last frame when it sees CI, CONTINUOUS_INTEGRATION or
// CI_* variables, and the TUI tests read the screen while it runs. CI=false turns that off;
// this preload runs before any test file imports Ink.
process.env.CI = "false";

afterAll(async () => {
  await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
});
