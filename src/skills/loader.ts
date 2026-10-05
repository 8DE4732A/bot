import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";
import { logger } from "../utils/logger.ts";
import { SkillRegistry } from "./registry.ts";

export async function loadCustomSkills(cwd?: string): Promise<void> {
  const paths = getBotPaths(cwd);
  const skillsDir = paths.skillsDir;

  if (!existsSync(skillsDir)) return;

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const registry = SkillRegistry.getInstance();

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = join(skillsDir, entry.name, "index.ts");
        if (existsSync(skillPath)) {
          try {
            logger.debug("SkillLoader", `Loading custom skill from ${skillPath}`);
            const mod = await import(skillPath);
            if (mod.default && mod.default.id && mod.default.extension) {
              registry.register({
                id: mod.default.id,
                name: mod.default.name || entry.name,
                description: mod.default.description || "Custom local skill",
                category: "custom",
                builtin: false,
                extension: mod.default.extension,
              });
              logger.info("SkillLoader", `Successfully loaded custom skill: ${mod.default.id}`);
            }
          } catch (err) {
            logger.error("SkillLoader", `Failed to load custom skill at ${skillPath}:`, err);
          }
        }
      }
    }
  } catch (err) {
    logger.warn("SkillLoader", `Error scanning skills directory ${skillsDir}: ${err}`);
  }
}
