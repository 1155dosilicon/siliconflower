import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";
import { APP_VERSION } from "../src/version.js";

describe("version", () => {
  test("keeps package and runtime versions synchronized", () => {
    expect(APP_VERSION).toBe(packageJson.version);
  });
});
