/**
 * 内置文档技能 skill-creator 的正文（构建期随源码打包，运行时不依赖磁盘文件）。
 *
 * 结构参考 agentskills 官方 skill-creator（Apache-2.0）与
 * docs/skill-creation/best-practices.mdx，按本项目"工作区 + 沙盒"的语义改写。
 * 正文刻意使用 ~~~ 围栏与纯文本路径，避免模板字符串内的反引号转义。
 */
export const SKILL_CREATOR_MD = `---
name: skill-creator
description: Create, modify, and validate Agent Skills in the agent's own workspace. Use this skill whenever the user asks to create a skill, turn a workflow into a reusable skill, improve or debug an existing skill, or when you notice a repeatable procedure that should become a durable capability. Also use it before writing anything under .agents/skills/.
---

# Skill Creator

Use this skill to create or improve an Agent Skill in the current agent's workspace. A skill is a folder containing a SKILL.md file with YAML frontmatter and Markdown instructions, optionally bundled with scripts, references, and assets.

Keep the process short and concrete:

1. Understand what the skill should do and when it should trigger.
2. Draft the skill directory and SKILL.md.
3. Add scripts or references only when they make the skill more reliable.
4. Self-check the result.
5. Test it with realistic prompts and iterate.

## 1. Capture intent

Before writing files, answer these questions:

- What should the skill let the agent do?
- When should the model use it? Which user phrases, file types, or task contexts should trigger it?
- What does a successful result look like?
- Does the task need deterministic scripts, reference material, or output templates?
- Are there edge cases, inputs, or constraints the agent must know?

If the user already demonstrated a workflow in the conversation, extract the steps, tools, corrections, and output format from that history instead of asking again.

## 2. Where the skill lives

Create skills only inside the current agent's workspace:

~~~
.agents/skills/<skill-name>/
├── SKILL.md          # required
├── scripts/          # optional: deterministic or repetitive operations
├── references/       # optional: documentation loaded only when needed
├── assets/           # optional: templates, images, data files
└── ...               # any additional files
~~~

Rules:

- The directory name must equal the frontmatter name.
- Use lowercase letters, digits, and hyphens. Do not start or end with a hyphen and do not use consecutive hyphens.
- Do not write secrets, tokens, or credentials into a skill.
- Do not try to bypass the sandbox, the network allowlist, or the path boundaries. Bundled scripts run with the same permissions as any other script the agent writes.
- The current workspace is the agent's own private area. Do not create skills in another agent's workspace or under the platform skills directory.

## 3. Write SKILL.md

Start with YAML frontmatter:

~~~
---
name: pdf-processing
description: Extract PDF text, fill forms, and merge PDFs. Use when the user works with PDF files, forms, or document extraction.
---
~~~

Required fields:

- name: 1-64 characters, lowercase letters/digits/hyphens, equal to the directory name.
- description: 1-1024 characters. Say both what the skill does and when to use it. Put all triggering context here; the body is only read after activation.

Optional fields:

- license: a license name or a pointer to a bundled license file.
- compatibility: environment requirements (runtime, packages, network), at most 500 characters.
- metadata: a string-to-string map for client-specific data.
- allowed-tools: space-separated tool hints (experimental; this client does not enforce it).

Write the body in the imperative form. Explain why a step matters instead of piling up MUSTs. Prefer procedures over menus, provide sensible defaults, and include examples of input and output when the format matters.

## 4. Use progressive disclosure

The model first sees only name and description. The full SKILL.md is loaded when the skill is activated. Bundled resources are read only when the instructions point to them.

- Keep SKILL.md under 500 lines. If it grows, move details into references/ and tell the model exactly when to read each file.
- Put deterministic or repetitive operations into scripts/ and list the scripts in SKILL.md.
- Reference files with paths relative to the skill directory, for example scripts/extract.py.
- For large reference files, add a short table of contents at the top.
- Do not duplicate what the model already knows. Add the missing domain knowledge, gotchas, and exact commands.

## 5. Writing patterns that work

- **Gotchas**: call out non-obvious failure modes explicitly.
- **Examples**: show one realistic input and the expected output.
- **Checklists**: use them for multi-step workflows where skipping a step causes failures.
- **Validation loops**: for fragile operations, prescribe plan -> validate -> execute, and tell the model what to check after each step.
- **Output templates**: give the exact structure when downstream consumers depend on it.
- **Defaults**: choose a safe default instead of presenting every possible option.

## 6. Self-check before finishing

- Directory name and frontmatter name match.
- description is non-empty, specific, and includes trigger contexts.
- SKILL.md has no secrets and no instructions that bypass the sandbox.
- Relative paths resolve from the skill directory.
- Bundled scripts are runnable in the sandbox and document their dependencies.
- Large reference material is split out and clearly pointed to.
- The skill says what to do, not just what the topic is about.

## 7. Test and iterate

After writing the skill:

1. Write 2-3 realistic prompts a user would actually say.
2. Run them as if the skill had just been discovered through its description.
3. Check whether the model activates the skill at the right time.
4. Check whether the instructions produce the expected result.
5. Fix the description if the skill triggers too rarely, and fix the body if it triggers but the result is wrong.
6. Repeat until the skill is reliable.

A useful skill is small, specific, and easy to follow. Prefer improving an existing skill over creating a near-duplicate.
`;
