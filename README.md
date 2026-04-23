# postofficex

PostOfficeX is a Bun-based mail server that accepts inbound email over SMTP, supports authenticated SMTP client submission for outbound mail, stores local messages on disk, and exposes POP3 and IMAP for client access.

## Features

- SMTP receive for configured local domains only
- Authenticated SMTP submission for mail clients on ports `587` and `465`
- Outbound SMTP delivery to recipient MX hosts
- Per-recipient mailboxes from file config
- Raw `.eml` message preservation under `data/`
- Attachment metadata extraction into sidecar JSON
- POP3 retrieval with `STAT`, `LIST`, `UIDL`, `RETR`, `DELE`, `RSET`, `QUIT`
- IMAP folder access with `LIST`, `SELECT`, `FETCH`, `STORE`, `SEARCH`, `COPY`, `APPEND`, `EXPUNGE`, and `IDLE`
- Standard POP3 delete-on-`QUIT` semantics
- Implicit TLS client listeners on `465` (submission), `995` (POP3), and `993` (IMAP)
- Optional SMTP `STARTTLS`, POP3 `STLS`, and IMAP `STARTTLS` configuration, with Bun deployment caveats
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
   The example config does not create any mail users by default, so define at least one user before testing SMTP, submission, POP3, or IMAP.
   To enable the admin UI, set `admin.password` or `admin.passwordHash` in `config.json`.
5. Start the server:

```bash
bun run src/index.js
```

To print the application version without starting listeners:

```bash
bun run src/index.js --version
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
{"status":"OK","name":"postofficex","version":"0.1.0"}
```

This is intended for uptime checks and basic status monitoring on the admin port.

Important:

- `/ping` is only available when the admin listener is enabled.
- The admin listener only starts when `admin.password` or `admin.passwordHash` is set.

## Storage Layout

Messages are stored beneath the configured storage root, by default `./data`:

- `data/mailboxes/<mailbox>/cur/*.eml`: raw stored message blobs
- `data/mailboxes/<mailbox>/tmp/*.tmp`: in-progress SMTP writes
- `data/mailboxes/<mailbox>/meta/*.json`: `INBOX` folder records, POP3-visible metadata, flags, and envelope data
- `data/mailboxes/<mailbox>/messages/*.json`: shared message metadata
- `data/mailboxes/<mailbox>/folders/<folder>/`: additional IMAP folders and per-folder metadata

POP3 and IMAP operate on the same stored mail. POP3 reads the `INBOX` view. IMAP exposes `INBOX` plus user-created folders, per-folder UIDs, and message flags.

## Client Submission

Use the submission listeners for mail clients:

- `587`: SMTP submission with `AUTH`
- `465`: implicit TLS SMTP submission
- `993`: implicit TLS IMAP
- `995`: implicit TLS POP3

Submission uses the configured mail users:

- `username` is the primary POP3 and SMTP `AUTH` login name
- the server also accepts one of the user's configured full email addresses as the login name
- `passwordHash` is used for SMTP `AUTH` and POP3 `PASS`
- submitted `MAIL FROM` must match one of that user's configured `addresses`

Local-only submitted messages are stored directly in local mailboxes. Submitted messages with external recipients are delivered outbound to the recipient domain's MX hosts.

## TLS Decision

This deployment currently uses implicit TLS on dedicated ports as the supported client path:

- `465` for SMTP submission
- `993` for IMAP
- `995` for POP3

Finding:

- Bun's server-side plain-socket upgrade path is not currently reliable here for SMTP `STARTTLS` / POP3 `STLS` / IMAP `STARTTLS`.

Decision:

- keep implicit TLS enabled on dedicated ports
- keep `STARTTLS`, `STLS`, and IMAP `STARTTLS` disabled in production config until Bun's upgrade path is verified working

Operationally, this means:

- mail clients should use `465` instead of `587 STARTTLS`
- mail clients should use `993` instead of `143 STARTTLS`
- mail clients should use `995` instead of `110 STLS`
- inbound SMTP on `25` currently runs without `STARTTLS`

## Notes

- The inbound SMTP listener only accepts mail for explicitly configured local addresses.
- The submission listener requires authentication and is intended for trusted mail clients.
- Outbound delivery goes directly to recipient MX hosts. There is no unauthenticated open relay and no smarthost relay configuration.
- It does not implement spam filtering, antivirus scanning, or DKIM.
- For internet-facing deployments, provide real certificates and bind to standard ports through your service manager or container runtime.

## Let's Encrypt

The server reads its TLS material from the paths in `config.json`. Your current config already points to:

```json
"tls": {
  "certFile": "./certs/server.crt",
  "keyFile": "./certs/server.key"
}
```

This repo now includes a Certbot flow that keeps those filenames stable while replacing the Cloudflare edge certs with real Let’s Encrypt certificates:

1. Install `certbot` on the host.
2. Start PostOfficeX with a PID file so the deploy hook can signal it:

```bash
POSTOFFICEX_CONFIG=./config.json POSTOFFICEX_PID_FILE=./postofficex.pid bun run src/index.js
```

3. Issue the certificate for your mail host:

```bash
./scripts/install-letsencrypt.sh mail.postofficex.com admin@postofficex.com
```

If port `80` is already serving `/.well-known/acme-challenge/`, pass that webroot as a third argument instead of using Certbot standalone mode.

The Certbot deploy hook copies:

- `fullchain.pem` to `certs/server.crt`
- `privkey.pem` to `certs/server.key`

After renewals, the hook sends `SIGHUP` to the running process through `postofficex.pid`, and PostOfficeX reloads the certificate from disk without a full restart.

## systemd

This repo also includes a `systemd` unit at `./postofficex.service`. It runs the server from the repo root with:

```bash
POSTOFFICEX_CONFIG=/root/postofficex/config.json
POSTOFFICEX_PID_FILE=/root/postofficex/postofficex.pid
```

Install and enable it with:

```bash
sudo cp ./postofficex.service /etc/systemd/system/postofficex.service
sudo systemctl daemon-reload
sudo systemctl enable --now postofficex.service
```

The service defines `ExecReload=/bin/kill -HUP $MAINPID`, and the Certbot deploy hook will prefer reloading `postofficex.service` through `systemctl` when that unit is active.
