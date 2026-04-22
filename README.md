# postofficex

PostOfficeX is a Bun-based inbound mail server that accepts email over SMTP, stores each raw message on local disk, and exposes POP3 so clients can fetch stored mail.

## Features

- SMTP receive for configured local domains only
- Per-recipient mailboxes from file config
- Raw `.eml` message preservation under `data/`
- Attachment metadata extraction into sidecar JSON
- POP3 retrieval with `STAT`, `LIST`, `UIDL`, `RETR`, `DELE`, `RSET`, `QUIT`
- Standard POP3 delete-on-`QUIT` semantics
- Optional SMTP `STARTTLS` and POP3 implicit TLS / `STLS`
- Optional admin HTML UI for editing global settings and users

## Quick Start

1. Copy `config.example.json` to `config.json`.
2. Generate a password hash:

```bash
bun -e "console.log(await Bun.password.hash('change-me'))"
```

3. Put the hash into `config.json`.
4. Update domains, users, ports, and TLS paths as needed.
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

## Storage Layout

Messages are stored beneath the configured storage root, by default `./data`:

- `data/mailboxes/<mailbox>/cur/*.eml`: committed messages
- `data/mailboxes/<mailbox>/tmp/*.tmp`: in-progress SMTP writes
- `data/mailboxes/<mailbox>/meta/*.json`: POP3 metadata, envelope data, and attachment metadata

## Notes

- The server only accepts mail for explicitly configured local addresses.
- It does not relay outbound mail.
- It does not implement IMAP, spam filtering, antivirus scanning, or DKIM.
- For internet-facing deployments, provide real certificates and bind to standard ports through your service manager or container runtime.
