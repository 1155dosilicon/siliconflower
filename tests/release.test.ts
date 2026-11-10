import { describe, expect, test } from "bun:test";
import { bumpFiles, compareVersions, promoteChangelog, sectionBody, unreleasedBody } from "../scripts/release.js";
import { checkChanges } from "../scripts/check-changes.js";

const changelog = `# Changelog

## [Unreleased]

### Fixed
- algo

## [0.2.0] - 2026-01-02

### Added
- recurso

## [0.1.0] - 2026-01-01

- inicio

[0.1.0]: https://example.com
`;

describe("release script", () => {
  test("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.9", "0.10.0")).toBeLessThan(0);
  });

  test("reads the [Unreleased] and version sections", () => {
    expect(unreleasedBody(changelog)).toBe("### Fixed\n- algo");
    expect(sectionBody(changelog, "0.2.0")).toBe("### Added\n- recurso");
    expect(sectionBody(changelog, "0.1.0")).toBe("- inicio");
    expect(sectionBody(changelog, "0.3.0")).toBe("");
    expect(unreleasedBody("## [Unreleased]\n\n## [0.1.0] - x\n- a\n")).toBe("");
  });

  test("promotes [Unreleased] to the new version and leaves it empty", () => {
    const next = promoteChangelog(changelog, "0.3.0", "2026-02-01");
    expect(unreleasedBody(next)).toBe("");
    expect(sectionBody(next, "0.3.0")).toBe("### Fixed\n- algo");
    expect(sectionBody(next, "0.2.0")).toBe("### Added\n- recurso");
  });

  test("bumps every version file and fails on a file without the old version", () => {
    const out = bumpFiles(
      {
        "package.json": '{ "version": "0.1.0" }',
        "src/version.ts": 'export const APP_VERSION = "0.1.0";',
        "README.md": "![v](https://img.shields.io/badge/version-0.1.0-blue.svg)",
      },
      "0.1.0",
      "0.2.0",
    );
    expect(out["package.json"]).toBe('{ "version": "0.2.0" }');
    expect(out["src/version.ts"]).toContain('"0.2.0"');
    expect(out["README.md"]).toContain("version-0.2.0-");
    expect(() => bumpFiles({ "README.md": "version-0.0.9-" }, "0.1.0", "0.2.0")).toThrow();
  });
});

describe("changelog check", () => {
  test("requires a CHANGELOG line when code changes", () => {
    expect(checkChanges(["src/llm.ts"], false).ok).toBe(false);
    expect(checkChanges(["src/llm.ts", "CHANGELOG.md"], false).ok).toBe(true);
    expect(checkChanges(["src/llm.ts"], true).ok).toBe(true);
    expect(checkChanges(["tests/llm.test.ts", "README.md"], false).ok).toBe(true);
    expect(checkChanges(["desktop/src/main.ts"], false).ok).toBe(false);
  });
});
