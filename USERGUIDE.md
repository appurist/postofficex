# User Guide

This guide explains how to configure PostOfficeX, how global server settings work, and how to define mail users.

## Overview

PostOfficeX reads `./local.json` at startup by default. It also expects sibling `defaults.json` and `users.json` files in the same directory. If `./local.json` is missing, it falls back to `/etc/postofficex/local.json`. You can also pass `--config /path/to/local.json`.

Example:

```bash
./postofficex
```

On Windows:

```powershell
.\postofficex.exe --config "C:\mail\local.json"
```

If the config file is missing or invalid, startup fails with a configuration error message.

To print the application version without loading config or starting listeners:

```bash
bun run src/index.js --version
```

## Config Files

`defaults.json`

```json
{
  "server": {
    "smtp": {
      "host": "0.0.0.0",
      "port": 25,
      "allowPlaintext": true,
      "enableStartTls": true
    },
    "submission": {
      "host": "0.0.0.0",
      "port": 587,
      "tlsPort": 465,
      "allowPlaintext": false,
      "enableStartTls": false,
      "enableTls": true
    },
    "pop3": {
      "host": "0.0.0.0",
      "port": 110,
      "tlsPort": 995,
      "allowPlaintext": false,
      "enableStartTls": false,
      "enableTls": true
    },
    "imap": {
      "host": "0.0.0.0",
      "port": 143,
      "tlsPort": 993,
      "allowPlaintext": false,
      "enableStartTls": false,
      "enableTls": true
    }
  },
  "outbound": {
    "connectTimeoutMs": 30000,
    "preferStartTls": true
  },
  "tls": {
    "certFile": "./certs/server.crt",
    "keyFile": "./certs/server.key"
  },
  "limits": {
    "maxMessageBytes": 10485760,
    "maxRecipientsPerMessage": 32,
    "maxMailboxBytes": 52428800,
    "socketTimeoutMs": 300000,
    "maxInvalidAuthAttempts": 5
  },
  "storage": {
    "rootDir": "./data"
  },
  "admin": {
    "host": "0.0.0.0",
    "port": 80,
    "enableTls": false,
    "password": "",
    "passwordHash": ""
  }
}
```

`local.json`

```json
{
  "hostname": "mail.example.com",
  "domains": [
    "example.com"
  ],
  "admin": {
    "passwordHash": "$argon2id$..."
  },
  "server": {
    "smtp": {
      "hostname": "mx.example.com"
    }
  },
  "outbound": {
    "greetingHostname": "ehlo.example.com"
  }
}
```

`users.json`

```json
[
  {
    "username": "alice",
    "mailbox": "alice",
    "passwordHash": "$argon2id$...",
    "addresses": [
      "alice@example.com",
      "support@example.com"
    ]
  }
]
```

## Global Configuration

### `server.smtp`

- `host`: IP address to bind the SMTP listener to. Use `0.0.0.0` to listen on all interfaces.
- `port`: SMTP port to listen on.
  - Use `25` for real internet-facing inbound email.
  - `2525` is useful for testing.
- `hostname`: Optional SMTP-only hostname override.
  - If omitted, PostOfficeX uses the global `hostname` from `local.json`.
- `allowPlaintext`: Currently not enforced by SMTP logic. It is safe to leave `true` unless you plan to extend the server.
- `enableStartTls`: Enables SMTP `STARTTLS`.
  - If `true`, `tls.certFile` and `tls.keyFile` must exist and be readable.

### `server.pop3`

- `host`: IP address to bind the POP3 listener to.
- `port`: Plain POP3 port.
  - Use `110` for standard POP3.
  - Use `2110` for testing.
- `tlsPort`: Implicit TLS POP3 port.
  - Use `995` for standard POP3-over-TLS.
- `allowPlaintext`: Controls whether `USER`/`PASS` can be used before TLS.
  - If `false`, clients must use implicit TLS on `tlsPort` or upgrade with `STLS`.
- `enableStartTls`: Enables `STLS` on the plain POP3 port.
- `enableTls`: Enables the implicit TLS POP3 listener on `tlsPort`.
  - If either TLS option is enabled, `tls.certFile` and `tls.keyFile` must exist and be readable.

### `server.imap`

- `host`: IP address to bind the IMAP listener to.
- `port`: Plain IMAP port.
  - Use `143` for standard IMAP.
- `tlsPort`: Implicit TLS IMAP port.
  - Use `993` for standard IMAP-over-TLS.
- `allowPlaintext`: Controls whether `LOGIN` is allowed before TLS on the plain IMAP port.
- `enableStartTls`: Reserved for IMAP `STARTTLS` support on the plain port.
- `enableTls`: Enables the implicit TLS IMAP listener on `tlsPort`.
  - If enabled, `tls.certFile` and `tls.keyFile` must exist and be readable.

Phase 1 IMAP support is aimed at practical desktop-client compatibility:

- folder hierarchy with always-present `INBOX`
- `LIST`, `LSUB`, `SELECT`, `EXAMINE`, `CREATE`, `DELETE`, `RENAME`
- `STATUS`, `FETCH`, `UID FETCH`, `STORE`, `UID STORE`, `SEARCH`, `UID SEARCH`
- `COPY`, `UID COPY`, `APPEND`, `EXPUNGE`, `CLOSE`, `IDLE`

### `server.submission`

`server.submission` controls authenticated SMTP client submission.

- `host`: IP address to bind the submission listeners to.
- `port`: Plain submission port.
  - Use `587` for standard authenticated submission.
- `tlsPort`: Implicit TLS submission port.
  - Use `465` for SMTPS / implicit TLS submission.
- `allowPlaintext`: Controls whether clients may authenticate without TLS on the plain submission port.
  - If `false`, clients on `port` must use `STARTTLS` before `AUTH`.
- `enableStartTls`: Enables `STARTTLS` on the plain submission port.
- `enableTls`: Enables the implicit TLS submission listener on `tlsPort`.

For Bun deployments, implicit TLS on `465`, `993`, and `995` is the recommended client path. Plain-port upgrade commands (`STARTTLS` / `STLS`) should remain disabled until Bun's server-side socket upgrade path is reliable.

Deployment finding and decision:

- Finding: on this Bun deployment, server-side upgrades from plaintext to TLS on an existing socket were not reliable for SMTP `STARTTLS`, POP3 `STLS`, or IMAP `STARTTLS`.
- Decision: use implicit TLS by port number for clients, keep `465`, `993`, and `995` enabled, and leave plain-port TLS upgrades disabled until Bun's upgrade path is verified working.
- Client guidance: configure mail clients for implicit TLS on `465` for submission, `993` for IMAP, and `995` for POP3.

Submission is separate from inbound SMTP:

- inbound SMTP on `server.smtp.port` only accepts mail for configured local recipients
- submission on `server.submission.port` and `server.submission.tlsPort` requires authentication and can send to external recipients

### `outbound`

`outbound` controls how submitted external mail is sent to recipient MX hosts.

- `greetingHostname`: Optional outbound `EHLO` override.
  - If omitted, PostOfficeX uses `server.smtp.hostname`, which itself falls back to `local.json.hostname`.
- `connectTimeoutMs`: Outbound connection timeout per target host.
- `preferStartTls`: If `true`, PostOfficeX attempts `STARTTLS` when the remote server advertises it.

Important:

- outbound delivery is only used for authenticated submission
- PostOfficeX does not provide an unauthenticated open relay
- there is no smarthost / upstream relay configuration in the current implementation

### `tls`

- `certFile`: Path to the PEM certificate file.
- `keyFile`: Path to the PEM private key file.

These paths are resolved relative to the directory containing `local.json`.

Example:

- `local.json` at `/opt/postofficex/local.json`
- `certFile` set to `./certs/server.crt`
- actual certificate path becomes `/opt/postofficex/certs/server.crt`

### `limits`

- `maxMessageBytes`: Maximum raw SMTP message size in bytes.
- `maxRecipientsPerMessage`: Maximum number of accepted `RCPT TO` recipients per message.
- `maxMailboxBytes`: Maximum total mailbox size on disk before delivery is rejected.
- `socketTimeoutMs`: Idle socket timeout in milliseconds.
- `maxInvalidAuthAttempts`: Maximum invalid POP3 password attempts before the connection is closed.

### `storage`

- `rootDir`: Root folder for all stored messages and metadata.

This path is also resolved relative to the directory containing `local.json`.

Example:

```json
"storage": {
  "rootDir": "./data"
}
```

This creates mailbox storage under:

- `data/mailboxes/<mailbox>/cur`
- `data/mailboxes/<mailbox>/tmp`
- `data/mailboxes/<mailbox>/meta`
- `data/mailboxes/<mailbox>/messages`
- `data/mailboxes/<mailbox>/folders`

Storage model notes:

- raw message blobs stay in `cur/*.eml`
- `meta/*.json` holds `INBOX` folder records, including POP3-visible metadata and IMAP flags
- `messages/*.json` holds shared per-message metadata
- extra IMAP folders keep their own per-folder metadata under `folders/`
- POP3 and IMAP expose the same underlying stored mail, with POP3 reading the `INBOX` view only

### `domains`

`domains` is the list of local domains this server accepts mail for.

Important:

- A message is not accepted just because its domain appears here.
- The full recipient address must also appear in some user's `addresses` list.

Example:

```json
"domains": [
  "example.com",
  "example.net"
]
```

### `admin`

The admin UI is disabled by default. It becomes active when either `admin.password` or `admin.passwordHash` is non-empty.

- `host`: HTTP bind address for the admin UI.
- `port`: HTTP port for the admin UI. Default is `80`.
- `enableTls`: Enables HTTPS for the admin listener using `tls.certFile` and `tls.keyFile`.
- `password`: Plaintext admin password. Supported, but less safe.
- `passwordHash`: Bun-compatible password hash for the admin login.

Recommended:

- leave `password` empty
- store only `passwordHash`
- set `enableTls` to `true` when exposing the admin UI over a network
- bind the admin UI to a trusted network or protect it with a reverse proxy

If both are set, `passwordHash` is used for authentication.

If `admin.enableTls` is `true`, the admin listener serves HTTPS and reuses the same certificate and key files configured under `tls`.

### Let's Encrypt Renewal

If you keep `tls.certFile` and `tls.keyFile` pointed at `./certs/server.crt` and `./certs/server.key`, you can use the included Certbot scripts to populate that folder with Let’s Encrypt certificates.

Recommended startup:

```bash
POSTOFFICEX_PID_FILE=./postofficex.pid bun run src/index.js
```

Issue the first certificate:

```bash
./scripts/install-letsencrypt.sh mail.postofficex.com admin@postofficex.com
```

Or, when another web server already serves ACME challenges:

```bash
./scripts/install-letsencrypt.sh mail.postofficex.com admin@postofficex.com /var/www/certbot
```

The Certbot deploy hook copies the renewed certificate and key into `certs/` and signals the process with `SIGHUP`. PostOfficeX then reloads the TLS files from disk for:

- SMTP `STARTTLS`
- submission TLS on `465`
- POP3 TLS on `995`
- admin HTTPS

### systemd Service

The repo includes `postofficex.service` for hosts that run PostOfficeX under `systemd`.

It sets:

- `WorkingDirectory=/root/postofficex`
- built-in config lookup from `./local.json`
- `POSTOFFICEX_PID_FILE=/root/postofficex/postofficex.pid`

Install it with:

```bash
cp /root/postofficex/postofficex.service /etc/systemd/system/postofficex.service
systemctl daemon-reload
systemctl enable --now postofficex.service
```

When the unit is active, the Let’s Encrypt deploy hook will reload the service through `systemctl` after certificate renewals.

When the admin listener is enabled, it also provides an unauthenticated health endpoint on the same host and port:

```text
GET /ping
```

Response:

```json
{"status":"OK","name":"postofficex","version":"0.1.0"}
```

This is useful for:

- uptime checks
- container health checks
- external monitoring probes

Important:

- `/ping` is not available unless the admin listener is enabled.
- If `admin.password` and `admin.passwordHash` are both empty, neither the admin UI nor `/ping` will be available.

## Defining Users

Each entry in `users` defines:

- the primary POP3 login name
- the primary SMTP submission login name
- the mailbox folder name on disk
- the password hash used for POP3 login and SMTP submission auth
- the full email addresses that deliver into that mailbox

Example:

```json
{
  "username": "alice",
  "mailbox": "alice",
  "passwordHash": "$argon2id$...",
  "addresses": [
    "alice@example.com",
    "support@example.com"
  ]
}
```

### `username`

- Used for POP3 `USER`.
- Used for SMTP submission `AUTH`.
- The server also accepts any one of that user's configured full email addresses as an alternate POP3 or SMTP submission login.
- Case is normalized to lowercase when config is loaded.

Example:

```text
USER alice
PASS your-password
```

Also accepted when `alice@example.com` belongs to that same user:

```text
USER alice@example.com
PASS your-password
```

### `mailbox`

- Local mailbox identifier used on disk.
- Messages for every address in `addresses` are stored in this mailbox.
- Case is normalized to lowercase when config is loaded.

For the example above, mail is stored under:

```text
data/mailboxes/alice/
```

### `passwordHash`

- Must be a Bun-compatible password hash.
- The server does not store plaintext user passwords.
- The same hash is used for POP3 and SMTP submission authentication.

Generate a hash with Bun:

```bash
bun -e "console.log(await Bun.password.hash('change-me'))"
```

Then place the generated hash into `passwordHash`.

### `addresses`

- List of exact recipient email addresses that should be accepted for this mailbox.
- Addresses are normalized to lowercase when config is loaded.
- SMTP delivery requires an exact address match here.
- SMTP submission `MAIL FROM` must also match one of the authenticated user's addresses.

Example:

```json
"addresses": [
  "alice@example.com",
  "billing@example.com",
  "sales@example.com"
]
```

All three addresses deliver into the same mailbox.

## How SMTP Recipient Matching Works

For a recipient to be accepted by SMTP, both conditions must be true:

1. The recipient domain must be present in `domains`.
2. The full recipient address must appear in some user's `addresses`.

Example:

```json
"domains": ["example.com"],
"users": [
  {
    "username": "alice",
    "mailbox": "alice",
    "passwordHash": "$argon2id$...",
    "addresses": ["alice@example.com"]
  }
]
```

Results:

- `RCPT TO:<alice@example.com>`: accepted
- `RCPT TO:<bob@example.com>`: rejected
- `RCPT TO:<alice@example.net>`: rejected

This is the reason a test may fail with:

```text
550 5.1.1 recipient rejected
```

## How SMTP Submission Works

SMTP submission is for your own mail clients, not for arbitrary internet senders.

For submission:

1. The client connects to `server.submission.port` or `server.submission.tlsPort`.
2. The client authenticates with either the configured `username` or one of that user's configured email addresses, plus the matching password.
3. `MAIL FROM` must match one of that user's configured `addresses`.
4. Local-only recipients are stored directly in local mailboxes.
5. Submitted messages with external recipients are delivered outbound to recipient MX hosts.

Example:

```json
"users": [
  {
    "username": "alice",
    "mailbox": "alice",
    "passwordHash": "$argon2id$...",
    "addresses": [
      "alice@example.com",
      "sales@example.com"
    ]
  }
]
```

Results:

- login as `alice` is allowed
- login as `alice@example.com` is also allowed
- `MAIL FROM:<alice@example.com>` is allowed
- `MAIL FROM:<sales@example.com>` is allowed
- `MAIL FROM:<bob@example.com>` is rejected for that login

## Common Configuration Patterns

### One mailbox per user

```json
"users": [
  {
    "username": "alice",
    "mailbox": "alice",
    "passwordHash": "$argon2id$...",
    "addresses": ["alice@example.com"]
  },
  {
    "username": "bob",
    "mailbox": "bob",
    "passwordHash": "$argon2id$...",
    "addresses": ["bob@example.com"]
  }
]
```

### Multiple addresses into one mailbox

```json
"users": [
  {
    "username": "support",
    "mailbox": "support",
    "passwordHash": "$argon2id$...",
    "addresses": [
      "support@example.com",
      "help@example.com",
      "info@example.com"
    ]
  }
]
```

### Separate domains on one server

```json
"domains": [
  "example.com",
  "example.net"
],
"users": [
  {
    "username": "alice",
    "mailbox": "alice",
    "passwordHash": "$argon2id$...",
    "addresses": [
      "alice@example.com",
      "alice@example.net"
    ]
  }
]
```

## Recommended Internet-Facing Settings

For public deployment:

- Use SMTP port `25`.
- Use submission port `587`.
- Use implicit TLS submission port `465`.
- Use POP3 port `110` and/or implicit TLS port `995`.
- Set `local.json.hostname` to your real mail hostname.
- Set SMTP `enableStartTls`, submission `enableStartTls`, submission `enableTls`, and POP3 `enableTls` to `true`.
- Set `server.pop3.allowPlaintext` to `false`.
- Set `server.submission.allowPlaintext` to `false`.
- Use real certificate files.
- Open the required firewall ports.
- Point your domain's `MX` record to the SMTP hostname.

Example:

```json
"server": {
  "smtp": {
    "host": "0.0.0.0",
    "port": 25,
    "hostname": "mail.example.com",
    "allowPlaintext": true,
    "enableStartTls": true
  },
  "submission": {
    "host": "0.0.0.0",
    "port": 587,
    "tlsPort": 465,
    "allowPlaintext": false,
    "enableStartTls": true,
    "enableTls": true
  },
  "pop3": {
    "host": "0.0.0.0",
    "port": 110,
    "tlsPort": 995,
    "allowPlaintext": false,
    "enableTls": true
  }
}
```

## Testing After Configuration

Minimum SMTP test:

1. Connect to the SMTP port.
2. Send `EHLO`.
3. Send `MAIL FROM`.
4. Send `RCPT TO` using an address that exactly matches one of the configured `users[].addresses`.
5. Only send `DATA` if the server returns `250`.

Minimum POP3 test:

1. Connect to the POP3 port.
2. Send `USER` with either `users[].username` or one of that user's configured full email addresses.
3. Send `PASS` with the password that matches `passwordHash`.
4. Use `STAT`, `LIST`, and `RETR`.

Minimum SMTP submission test:

1. Connect to the submission port.
2. Send `EHLO`.
3. Authenticate with `AUTH PLAIN` or `AUTH LOGIN`.
4. Send `MAIL FROM` using one of the authenticated user's configured addresses.
5. Send `RCPT TO`.
6. Send `DATA`.

## Troubleshooting

### `550 5.1.1 recipient rejected`

Check all of the following:

- The domain is present in `domains`.
- The full recipient address is present in some user's `addresses`.
- The address in your SMTP test matches exactly.

### POP3 login fails

Check all of the following:

- `USER` matches either `username` or one of that user's configured full email addresses.
- `passwordHash` was generated from the password you are testing.
- If `allowPlaintext` is `false`, you are using TLS.

### SMTP submission auth fails

Check all of the following:

- You are connecting to the submission port, not the inbound SMTP port.
- The login matches either a configured `username` or one of that user's configured full email addresses.
- The password matches that user's `passwordHash`.
- If `server.submission.allowPlaintext` is `false`, the client is using TLS or `STARTTLS`.

### SMTP submission sender rejected

If you receive a sender rejection, check that:

- `MAIL FROM` exactly matches one of the authenticated user's `addresses`
- the address belongs to the same configured user account used for `AUTH`

### TLS startup fails

Check all of the following:

- `enableStartTls` or `enableTls` is only set if certificate files exist.
- `certFile` and `keyFile` paths are correct relative to `local.json`.
- The process can read both files.
