# postofficex

PostOfficeX is a Bun-based mail server that accepts inbound email over SMTP, supports authenticated SMTP client submission for outbound mail, stores local messages on disk, and exposes POP3 so clients can fetch stored mail.

## Features

- SMTP receive for configured local domains only
- Authenticated SMTP submission for mail clients on ports `587` and `465`
- Outbound SMTP delivery to recipient MX hosts
- Per-recipient mailboxes from file config
- Raw `.eml` message preservation under `data/`
- Attachment metadata extraction into sidecar JSON
- POP3 retrieval with `STAT`, `LIST`, `UIDL`, `RETR`, `DELE`, `RSET`, `QUIT`
- Standard POP3 delete-on-`QUIT` semantics
- Optional SMTP `STARTTLS` and POP3 implicit TLS / `STLS`
- Optional admin HTML UI for editing global settings and users
- Optional admin `/ping` JSON health endpoint on the admin port
- Optional HTTPS for the admin listener using the configured TLS certificate and key

## Quick Start

1. Copy `config.example.json` to `config.json`.
2. Generate a password hash:

```bash
bun -e "console.log(await Bun.password.hash('change-me'))"
```

3. Put the hash into `config.json`.
4. Update domains, users, ports, and TLS paths as needed.
   The example config does not create any mail users by default, so define at least one user before testing SMTP, submission, or POP3.
   To enable the admin UI, set `admin.password` or `admin.passwordHash` in `config.json`.
5. Start the server:

```bash
bun run src/index.js
```

If `config.json` is missing or unreadable, startup now reports a direct configuration error that includes the expected path and suggests setting `POSTOFFICEX_CONFIG`.

Or build a single Bun-targeted binary:

```bash
bun build --compile ./src/index.js --outfile postofficex
```

Then run it with:

```bash
POSTOFFICEX_CONFIG=./config.json ./postofficex
```

On Windows, Bun compile output is an `.exe`. If you build on Windows, expect `postofficex.exe`. To cross-compile a Windows binary from another platform, use Bun's Windows target, for example:

```bash
bun build --compile --target=bun-windows-x64 ./src/index.js --outfile postofficex.exe
```

## Health Check

When the admin listener is enabled, it also exposes an unauthenticated health endpoint:

```text
GET /ping
```

Response:

```json
{"status":"OK","name":"postofficex"}
```

This is intended for uptime checks and basic status monitoring on the admin port.

Important:

- `/ping` is only available when the admin listener is enabled.
- The admin listener only starts when `admin.password` or `admin.passwordHash` is set.

## Storage Layout

Messages are stored beneath the configured storage root, by default `./data`:

- `data/mailboxes/<mailbox>/cur/*.eml`: committed messages
- `data/mailboxes/<mailbox>/tmp/*.tmp`: in-progress SMTP writes
- `data/mailboxes/<mailbox>/meta/*.json`: POP3 metadata, envelope data, and attachment metadata

## Client Submission

Use the submission listeners for mail clients:

- `587`: SMTP submission with `AUTH` and optional `STARTTLS`
- `465`: implicit TLS SMTP submission

Submission uses the configured mail users:

- `username` is the SMTP `AUTH` login name
- `passwordHash` is used for SMTP `AUTH` and POP3 `PASS`
- submitted `MAIL FROM` must match one of that user's configured `addresses`

Local-only submitted messages are stored directly in local mailboxes. Submitted messages with external recipients are delivered outbound to the recipient domain's MX hosts.

## Notes

- The inbound SMTP listener only accepts mail for explicitly configured local addresses.
- The submission listener requires authentication and is intended for trusted mail clients.
- Outbound delivery goes directly to recipient MX hosts. There is no unauthenticated open relay and no smarthost relay configuration.
- It does not implement IMAP, spam filtering, antivirus scanning, or DKIM.
- For internet-facing deployments, provide real certificates and bind to standard ports through your service manager or container runtime.
