# Repository Guidelines

## Project Structure & Module Organization

- `src/`: runtime code for SMTP, POP3, admin UI, storage, config loading, and outbound delivery.
- `test/`: Bun test suite. Add new protocol and regression coverage here.
- `scripts/`: operational helpers, including Let’s Encrypt install/deploy hooks.
- `certs/`: active local TLS files used by the app.
- `config.example.json`: baseline configuration template.
- `postofficex.service`: example `systemd` unit for Linux deployments.
- `README.md`, `USERGUIDE.md`, `TODO.md`: operator docs and tracked follow-up work.

## Build, Test, and Development Commands

- `bun run src/index.js` or `pnpm start`: run the server with `./config.json`.
- `pnpm test`: run the full Bun test suite.
- `pnpm build`: compile a standalone binary named `postofficex` (or `postofficex.exe` on Windows).
- `POSTOFFICEX_CONFIG=./config.json bun run src/index.js`: run against an explicit config path.

Use the helper scripts only when working on a Linux host that matches the documented deployment layout.

## Coding Style & Naming Conventions

- JavaScript only, ES modules, 2-space to 2-tab consistency with existing files; match the surrounding file exactly.
- Prefer small, direct functions and explicit protocol state over abstraction-heavy patterns.
- Use `camelCase` for variables/functions, `PascalCase` for classes, and lowercase filenames such as `server.js`, `storage.js`.
- Keep comments sparse and explanatory, not repetitive.

## Testing Guidelines

- Tests use `bun:test`.
- Name test files `*.test.js` under `test/`.
- Add regression tests for protocol behavior, auth flows, shutdown handling, and config-driven features.
- Run `pnpm test` before submitting changes; include tests for any SMTP/POP3/admin/TLS changes.

## Commit & Pull Request Guidelines

- Follow the existing history: short, imperative summaries such as `Improved shutdown/error handling`.
- Keep commits focused on one change area.
- PRs should state behavior changes, config/doc impacts, and any deployment implications.
- Include sample commands or log snippets when changing networking, TLS, or service behavior.

## Security & Configuration Tips

- Never commit real production secrets or private keys.
- Treat `config.json` as local/operator-specific; update `config.example.json` when config shape changes.
- For direct public TLS, use publicly trusted certificates, not Cloudflare Origin certs.
