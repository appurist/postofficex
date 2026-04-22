# User Guide

This guide explains how to configure PostOfficeX, how global server settings work, and how to define mail users.

## Overview

PostOfficeX reads one JSON config file at startup. By default it looks for `./config.json` relative to the current working directory. You can override that with `POSTOFFICEX_CONFIG`.

Example:

```bash
POSTOFFICEX_CONFIG=./config.json ./postofficex
```

On Windows:

```powershell
$env:POSTOFFICEX_CONFIG="C:\mail\config.json"
.\postofficex.exe
```

If the config file is missing or invalid, startup fails with a configuration error message.

## Full Config Example

```json
{
  "server": {
    "smtp": {
      "host": "0.0.0.0",
      "port": 25,
      "hostname": "mail.example.com",
      "allowPlaintext": true,
      "enableStartTls": true
    },
    "pop3": {
      "host": "0.0.0.0",
      "port": 110,
      "tlsPort": 995,
      "allowPlaintext": false,
      "enableTls": true
    }
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
    "password": "",
    "passwordHash": ""
  },
  "domains": [
    "example.com"
  ],
  "users": [
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
}
```

## Global Configuration

### `server.smtp`

- `host`: IP address to bind the SMTP listener to. Use `0.0.0.0` to listen on all interfaces.
- `port`: SMTP port to listen on.
  - Use `25` for real internet-facing inbound email.
  - `2525` is useful for testing.
- `hostname`: The SMTP greeting hostname shown in the `220` banner and `EHLO` response.
  - This should usually be the mail hostname for your server, such as `mail.example.com`.
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
- `enableTls`: Enables POP3 TLS support.
  - If `true`, `tls.certFile` and `tls.keyFile` must exist and be readable.

### `tls`

- `certFile`: Path to the PEM certificate file.
- `keyFile`: Path to the PEM private key file.

These paths are resolved relative to the directory containing `config.json`.

Example:

- `config.json` at `/opt/postofficex/config.json`
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

This path is also resolved relative to the directory containing `config.json`.

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
- `password`: Plaintext admin password. Supported, but less safe.
- `passwordHash`: Bun-compatible password hash for the admin login.

Recommended:

- leave `password` empty
- store only `passwordHash`
- bind the admin UI to a trusted network or protect it with a reverse proxy

If both are set, `passwordHash` is used for authentication.

When the admin listener is enabled, it also provides an unauthenticated health endpoint on the same host and port:

```text
GET /ping
```

Response:

```json
{"status":"OK","name":"postofficex"}
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

- the POP3 login name
- the mailbox folder name on disk
- the password hash used for POP3 login
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
- Case is normalized to lowercase when config is loaded.

Example:

```text
USER alice
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
- The server does not store plaintext passwords.

Generate a hash with Bun:

```bash
bun -e "console.log(await Bun.password.hash('change-me'))"
```

Then place the generated hash into `passwordHash`.

### `addresses`

- List of exact recipient email addresses that should be accepted for this mailbox.
- Addresses are normalized to lowercase when config is loaded.
- SMTP delivery requires an exact address match here.

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
- Use POP3 port `110` and/or implicit TLS port `995`.
- Set `server.smtp.hostname` to your real mail hostname.
- Set `enableStartTls` and `enableTls` to `true`.
- Set `server.pop3.allowPlaintext` to `false`.
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
2. Send `USER` with `users[].username`.
3. Send `PASS` with the password that matches `passwordHash`.
4. Use `STAT`, `LIST`, and `RETR`.

## Troubleshooting

### `550 5.1.1 recipient rejected`

Check all of the following:

- The domain is present in `domains`.
- The full recipient address is present in some user's `addresses`.
- The address in your SMTP test matches exactly.

### POP3 login fails

Check all of the following:

- `USER` matches `username`.
- `passwordHash` was generated from the password you are testing.
- If `allowPlaintext` is `false`, you are using TLS.

### TLS startup fails

Check all of the following:

- `enableStartTls` or `enableTls` is only set if certificate files exist.
- `certFile` and `keyFile` paths are correct relative to `config.json`.
- The process can read both files.
