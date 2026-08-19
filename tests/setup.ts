import { afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDataDir = join(tmpdir(), `.siliconflower-tests-${process.pid}`);
process.env.SILICONFLOWER_DATA_DIR = testDataDir;

afterAll(async () => {
  await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
});
