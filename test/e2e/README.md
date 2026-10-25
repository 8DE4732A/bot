# Real-provider Agent E2E

This suite calls a real model through `AgentManager.chat()`. It is disabled by
default and uses a fresh temporary `.bot` database and workspace for every run.
Run it as a standalone test process through the npm script; the script creates
an exclusive lock so the shared in-process database singleton cannot point at
another test directory.

```bash
BOT_E2E=1 \
BOT_E2E_PROTOCOL=openai-completions \
BOT_E2E_BASE_URL=https://api.example.com/v1 \
BOT_E2E_API_KEY=... \
BOT_E2E_MODEL=your-model \
bun run test:e2e
```

Optional variables:

- `BOT_E2E_PROVIDER_ID`: provider id stored in the temporary database
  (default: `e2e-provider`).
- `BOT_E2E_TIMEOUT_MS`: per-test and setup timeout
  (default: `120000`).

Supported `BOT_E2E_PROTOCOL` values:

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google`

The current cases verify:

- non-empty streamed chat response;
- multi-turn conversation memory;
- reset clears prior context;
- a real tool call (`get_current_time`) is surfaced in chat chunks.

No project credentials or project `.bot` data are read. Do not commit API keys
to shell wrappers or files.
