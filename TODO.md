# TODO

## Deployment

- Make `postofficex.service` portable instead of hard-coding `/root/postofficex` and `/root/.bun/bin/bun`.
  - Current unit assumes one specific install path and one specific Bun location.
  - A better version should either:
    - document itself as an example-only unit very explicitly, or
    - use an `EnvironmentFile`, a dedicated service user, and install-time path substitution.

- Harden the default Let’s Encrypt install flow in `scripts/install-letsencrypt.sh`.
  - The current default uses `certbot --standalone`, which conflicts with any service already bound to port `80`.
  - A better version should detect the conflict and fail with a clearer message or support a safer default flow such as explicit webroot/reverse-proxy integration.

## Testing

- Add automated coverage for `SIGHUP` certificate reload behavior.
  - The runtime supports TLS material reloads, but there is no direct test that exercises the signal-driven renewal path end to end.
