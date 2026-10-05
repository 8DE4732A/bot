import { describe, expect, it } from "bun:test";
import { SkillRegistry } from "../src/skills/registry.ts";

describe("Skills Registry", () => {
  const registry = SkillRegistry.getInstance();

  it("should have all built-in skills registered", () => {
    const skills = registry.listSkills();
    const ids = skills.map((s) => s.id);

    expect(ids).toContain("coding-tools");
    expect(ids).toContain("web-search");
    expect(ids).toContain("datetime");
  });

  it("should resolve extension registrations by skill ids", () => {
    const extensions = registry.resolveExtensions(["coding-tools", "datetime"]);
    expect(extensions.length).toBe(2);
    expect(extensions[0].name).toBe("coding-tools");
    expect(extensions[1].name).toBe("datetime");
  });
});
