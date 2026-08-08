import { describe, expect, test } from "bun:test";
import { loadSkills, SKILL_TOOL, skillsDir } from "../src/skills.js";

describe("skills", () => {
  test("skillsDir returns user skills path", () => {
    const dir = skillsDir();
    expect(dir).toContain(".siliconflower");
    expect(dir).toContain("skills");
  });

  test("loadSkills loads or auto-syncs embedded skills", async () => {
    const skills = await loadSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.name === "code-review")).toBe(true);
  });

  test("SKILL_TOOL has valid tool definition", () => {
    expect(SKILL_TOOL.name).toBe("read_skill");
    expect(SKILL_TOOL.inputSchema.required).toContain("name");
  });
});
