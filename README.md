# VoidKagami

A personal agent harness with a shared local daemon, terminal client, and Electron desktop client.

Requires Node.js 24.12+, pnpm 11+, Git, and a C/C++ compiler for the terminal's native input helpers.

```sh
pnpm install
pnpm dev login
pnpm dev
```

Use `pnpm dev --help` for headless runs, sessions, providers, and configuration. API providers accept their standard environment variables (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), or credentials configured through the clients. ChatGPT sign-in uses OpenAI's public OAuth flow.

```sh
pnpm check
pnpm build
pnpm desktop
```

The daemon starts on demand and keeps active runs alive after clients disconnect. Local configuration, credentials, JSONL session events, the derived SQLite index, and workspace snapshots live under `~/.voidkagami` (`VOIDKAGAMI_HOME` overrides it). Set `sandbox` in configuration to enable the platform sandbox; install `bubblewrap` for Linux. CLI and desktop clients use the same authenticated local JSON-RPC protocol.

The `ai`, `agent`, and `tui` packages contain project-owned source derived from Pi. Attribution and original license notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
