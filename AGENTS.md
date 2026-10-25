# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the Bun/TypeScript backend. Key areas are `core/` (Agent lifecycle, commands), `scheduler/` (durable tasks), `sandbox/`, `skills/`, `channels/`, `gateway/`, and `server/`.
- `src/cli.ts` is the CLI entry point; `src/server/ui/generated.ts` is generated and must not be edited manually.
- `web/src/` contains the React/Vite admin console; `web/dist/` is its build output.
- `test/` holds `bun:test` suites, with real-model tests under `test/e2e/`.
- `scripts/` contains build helpers; `docs/` and `CLAUDE.md` document architecture and implementation constraints.
- Runtime state belongs in `cwd/.bot/` and is ignored by Git.

## Build, Test, and Development Commands

- `bun install` installs pinned dependencies.
- `bun run dev` starts the backend and terminal REPL.
- `bun run dev:web` runs the backend plus Vite HMR.
- `bun test` runs the offline test suite.
- `bun run test:e2e` calls a real model; set `BOT_E2E_PROTOCOL`, `BOT_E2E_BASE_URL`, `BOT_E2E_API_KEY`, and `BOT_E2E_MODEL`.
- `bun run typecheck` checks backend and frontend TypeScript.
- `bun run build:web` rebuilds and embeds the admin UI; `bun run build:binary` creates `bin/bot`.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports with `.ts` extensions, two-space indentation, double quotes, and semicolons. Use `PascalCase` for types/components, `camelCase` for variables/functions, and kebab-case for most filenames. Event names use dot notation such as `scheduler.completed`. No linter or formatter is configured; preserve surrounding style and run `bun run typecheck`.

Database changes require a new append-only migration in `src/database/migrations.ts`. Do not change published pi packages without updating all three pinned `@earendil-works/*` versions together.

## Testing Guidelines

Name tests `*.test.ts`; group behavior by phase or subsystem as in `test/phase6-scheduler.test.ts`. Add regression tests beside the relevant suite and exercise production implementations rather than copied logic. Run a focused file with `bun test test/<file>.test.ts`, then run the full suite. Security, migration, scheduler, and recovery fixes should include failure-path tests. No coverage threshold is configured. Keep normal tests offline; E2E tests must use temporary data and explicit credentials.

## Commit & Pull Request Guidelines

Use Conventional Commits with concise Chinese summaries, for example `feat: 六期——Durable 调度与任务生命周期` or `fix(release): 保留二进制可执行位`. Commit bodies may list behavior, tests, migration impact, and risks.

Pull requests should explain the problem, implementation, verification commands, and compatibility or migration risks. Include screenshots for UI changes and identify new environment variables or database migrations. Never commit `.bot/`, API keys, channel secrets, or hand-edited generated assets.

## Security & Configuration

Configuration lives in SQLite, not config files. Preserve sandbox fail-closed behavior and never weaken secret redaction, path checks, or child-process environment filtering. Read `CLAUDE.md` before changing durable scheduling, sandboxing, migrations, or generated UI behavior.
