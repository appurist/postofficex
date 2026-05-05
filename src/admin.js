import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { saveConfig } from "./config.js";
import { buildUserDirectory } from "./config.js";
import {
  beginSubscription,
  buildConfirmUrl,
  buildEmailMessage,
  buildPublicListUrl,
  buildUnsubscribeUrl,
  confirmSubscription,
  findNewsletterByMailbox,
  findSubscriber,
  removeSubscriber
} from "./lists.js";
import { APP_DISPLAY_NAME, APP_NAME, APP_VERSION } from "./version.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseCookie(header) {
  const cookies = {};
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function parseAddressList(raw) {
  return raw
    .split(/[\r\n,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseDomains(raw) {
  return raw
    .split(/[\r\n,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function boolFromForm(form, key) {
  return form.get(key) === "on";
}

function numberFromForm(form, key, fallback) {
  const value = Number(form.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function authFingerprint(adminConfig) {
  return createHash("sha256").update(adminConfig?.passwordHash || adminConfig?.password || "").digest("hex");
}

function adminCookieAttributes(adminConfig) {
  return `Path=/; HttpOnly; SameSite=Lax${adminConfig?.enableTls ? "; Secure" : ""}`;
}

function isAdminPublicRoute(pathname, method) {
  return (
    (pathname === "/ping" && method === "GET") ||
    (pathname === "/login" && (method === "GET" || method === "POST")) ||
    (/^\/lists\/[^/]+$/.test(pathname) && method === "GET") ||
    (/^\/lists\/[^/]+\/subscribe$/.test(pathname) && (method === "GET" || method === "POST")) ||
    (/^\/lists\/[^/]+\/confirm$/.test(pathname) && method === "GET") ||
    (/^\/lists\/[^/]+\/unsubscribe$/.test(pathname) && (method === "GET" || method === "POST"))
  );
}

function isAdminAuthenticatedRoute(pathname, method) {
  return (
    (pathname === "/" && method === "GET") ||
    (pathname === "/logout" && method === "POST") ||
    (pathname === "/config/global" && method === "POST") ||
    (pathname === "/config/domains" && method === "POST") ||
    (pathname === "/users/save" && method === "POST") ||
    (pathname === "/users/delete" && method === "POST")
  );
}

export async function verifyAdminPassword(input, adminConfig) {
  if (adminConfig?.password) {
    return input === adminConfig.password;
  }

  if (adminConfig?.passwordHash) {
    try {
      return await Bun.password.verify(input, adminConfig.passwordHash);
    } catch {
      return false;
    }
  }

  return Boolean(adminConfig?.password) && input === adminConfig.password;
}

function isAdminEnabled(config) {
  return Boolean(config.admin?.password || config.admin?.passwordHash);
}

function renderLayout(title, body, flash = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f4f1ea;
      --panel: #fffdf8;
      --ink: #1c1c1c;
      --muted: #6c665f;
      --accent: #8c2f00;
      --line: #d9d0c3;
      --soft: #efe6d8;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: linear-gradient(180deg, #efe5d7 0%, var(--bg) 100%); color: var(--ink); }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
    h1, h2, h3 { margin: 0 0 12px; font-weight: 600; }
    p { color: var(--muted); }
    .flash { margin-bottom: 16px; padding: 12px 14px; background: #fff3cd; border: 1px solid #f0d98b; border-radius: 10px; }
    .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(50, 35, 10, 0.06); }
    label { display: block; margin: 12px 0 6px; font-size: 14px; color: var(--muted); }
    input, textarea, select { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: white; font: inherit; }
    textarea { min-height: 88px; resize: vertical; }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .inline { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .inline input { width: auto; }
    .toggle-grid { display: grid; gap: 5px 18px; margin-top: 14px; margin-bottom: 18px; }
    .toggle-row { display: grid; grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: center; }
    .toggle-label { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
    .toggle-cell { display: flex; align-items: center; gap: 8px; min-height: 28px; }
    .toggle-cell input { width: auto; margin: 0; }
    .toggle-cell.disabled { color: #9a9389; }
    @media (max-width: 780px) {
      .toggle-row { grid-template-columns: 1fr; gap: 6px; }
      .toggle-label { margin-bottom: 2px; }
    }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .actions.right { justify-content: flex-end; }
    button { border: 0; border-radius: 999px; padding: 10px 16px; font: inherit; background: var(--accent); color: white; cursor: pointer; }
    button.secondary { background: #4b5d67; }
    button.subtle { background: #8a877f; }
    .users { display: grid; gap: 16px; }
    .user { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--soft); }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
    .mono { font-family: "Courier New", monospace; }
    .section-heading { margin-bottom: 8px; }
    .section-heading.spacious { margin-top: 18px; }
    .tabbar { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 0; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 0 14px; align-items: end; }
    .tab-button { background: transparent; color: var(--muted); border: 1px solid var(--line); border-bottom: 0; border-radius: 14px 14px 0 0; padding-bottom: 12px; }
    .tab-button.active { background: var(--panel); color: var(--accent); border-color: var(--line); position: relative; top: 1px; }
    .logout-form { margin: 0 12px 6px 0; }
    .logout-button { border-radius: 999px; height: 32px; padding-top: 0; padding-bottom: 0; display: inline-flex; align-items: center; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
  </style>
</head>
<body>
  <div class="wrap">
    ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}
    ${body}
  </div>
  <script>
    (() => {
      const buttons = Array.from(document.querySelectorAll("[data-tab-button]"));
      const panels = Array.from(document.querySelectorAll("[data-tab-panel]"));
      if (buttons.length === 0 || panels.length === 0) {
        return;
      }
      const activate = (name) => {
        buttons.forEach((button) => button.classList.toggle("active", button.dataset.tabButton === name));
        panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.tabPanel === name));
      };
      buttons.forEach((button) => {
        button.addEventListener("click", () => activate(button.dataset.tabButton));
      });
      activate(buttons[0].dataset.tabButton);
    })();
  </script>
</body>
</html>`;
}

function renderLoginPage(flash = "") {
  return renderLayout(
    `${APP_DISPLAY_NAME} Admin`,
    `<div class="card" style="max-width: 420px; margin: 80px auto 0;">
      <h1>${APP_DISPLAY_NAME} Admin</h1>
      <p>Login to manage global server settings and mail users.</p>
      <p>Version ${escapeHtml(APP_VERSION)}</p>
      <form method="post" action="/login">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" required>
        <div class="actions right">
          <button type="submit">Login</button>
        </div>
      </form>
    </div>`,
    flash
  );
}

function renderUserEditor(user) {
  const newsletter = user.newsletter ?? {};
  const options = user.addresses
    .map(
      (address) =>
        `<option value="${escapeHtml(address)}" ${newsletter.address === address ? "selected" : ""}>${escapeHtml(address)}</option>`
    )
    .join("");
  return `<div class="user">
    <form method="post" action="/users/save">
      <input type="hidden" name="originalUsername" value="${escapeHtml(user.username)}">
      <div class="row">
        <div>
          <label>Username</label>
          <input name="username" value="${escapeHtml(user.username)}" required>
        </div>
        <div>
          <label>Mailbox</label>
          <input name="mailbox" value="${escapeHtml(user.mailbox)}" required>
        </div>
      </div>
      <label>Addresses</label>
      <textarea name="addresses" required>${escapeHtml(user.addresses.join("\n"))}</textarea>
      <div class="row">
        <div>
          <label>New password</label>
          <input name="password" type="password" placeholder="Leave blank to keep existing password">
        </div>
        <div>
          <label>Or password hash</label>
          <input name="passwordHash" placeholder="Leave blank to keep existing password hash">
        </div>
      </div>
      <h3 class="section-heading spacious">Newsletter</h3>
      <div class="inline"><input name="newsletterEnabled" type="checkbox" ${newsletter.enabled ? "checked" : ""}><span>Enable newsletter for this mailbox</span></div>
      <div class="row">
        <div>
          <label>Newsletter address</label>
          <select name="newsletterAddress">${options}</select>
        </div>
        <div>
          <label>Newsletter title</label>
          <input name="newsletterTitle" value="${escapeHtml(newsletter.title ?? "")}" placeholder="Newsletter">
        </div>
      </div>
      <div class="inline"><input name="newsletterPublicSubscription" type="checkbox" ${newsletter.publicSubscription ? "checked" : ""}><span>Allow public subscribe</span></div>
      <div class="inline"><input name="newsletterPublicUnsubscribe" type="checkbox" ${newsletter.publicUnsubscribe ? "checked" : ""}><span>Allow public unsubscribe</span></div>
      <div class="actions">
        <button type="submit">Save user</button>
      </div>
    </form>
    <form method="post" action="/users/delete">
      <input type="hidden" name="username" value="${escapeHtml(user.username)}">
      <div class="actions">
        <button class="subtle" type="submit">Delete user</button>
      </div>
    </form>
  </div>`;
}

function renderAdminPage(config, flash = "") {
  const usersHtml = config.users.map(renderUserEditor).join("");
  const sourceSummary =
    config.sources?.mode === "layered"
      ? `Local <span class="mono">${escapeHtml(config.sources.localConfigPath)}</span><br>Defaults <span class="mono">${escapeHtml(config.sources.defaultsConfigPath)}</span><br>Users <span class="mono">${escapeHtml(config.sources.usersConfigPath)}</span>`
      : `<span class="mono">${escapeHtml(config.configPath)}</span>`;
  const smtpHostnameOverride = config.local?.server?.smtp?.hostname ?? "";
  const outboundGreetingHostnameOverride = config.local?.outbound?.greetingHostname ?? "";
  const tabs = `<div class="tabs">
      <button class="tab-button" type="button" data-tab-button="global">Global</button>
      <button class="tab-button" type="button" data-tab-button="domains">Domains</button>
      <button class="tab-button" type="button" data-tab-button="users">Users</button>
      <button class="tab-button" type="button" data-tab-button="about">About</button>
    </div>`;
  const body = `<div class="topbar">
      <div>
        <h1>${APP_DISPLAY_NAME} Admin</h1>
      </div>
    </div>
    <div class="tabbar">
      ${tabs}
      <form class="logout-form" method="post" action="/logout">
        <button class="secondary logout-button" type="submit">Logout</button>
      </form>
    </div>
    <section class="tab-panel active" data-tab-panel="about">
      <div class="card">
        <h2>About</h2>
        <p>Version ${escapeHtml(APP_VERSION)}</p>
        <p>Admin UI changes are written back to ${sourceSummary}. Listener host, port, and TLS material changes may require a restart.</p>
      </div>
    </section>
    <section class="tab-panel" data-tab-panel="global">
      <div class="card">
        <h2>Global Settings</h2>
        <form method="post" action="/config/global">
          <div class="row">
            <div>
              <label>Mail hostname</label>
              <input name="hostname" value="${escapeHtml(config.hostname)}" required>
            </div>
            <div>
              <label>SMTP host</label>
              <input name="smtpHost" value="${escapeHtml(config.server.smtp.host)}" required>
            </div>
            <div>
              <label>SMTP port</label>
              <input name="smtpPort" type="number" value="${escapeHtml(config.server.smtp.port)}" required>
            </div>
          </div>
          <div class="row">
            <div>
              <label>POP3 host</label>
              <input name="pop3Host" value="${escapeHtml(config.server.pop3.host)}" required>
            </div>
            <div>
              <label>POP3 port</label>
              <input name="pop3Port" type="number" value="${escapeHtml(config.server.pop3.port)}" required>
            </div>
            <div>
              <label>POP3 TLS port</label>
              <input name="pop3TlsPort" type="number" value="${escapeHtml(config.server.pop3.tlsPort)}" required>
            </div>
          </div>
          <div class="row">
            <div>
              <label>IMAP host</label>
              <input name="imapHost" value="${escapeHtml(config.server.imap.host)}" required>
            </div>
            <div>
              <label>IMAP port</label>
              <input name="imapPort" type="number" value="${escapeHtml(config.server.imap.port)}" required>
            </div>
            <div>
              <label>IMAP TLS port</label>
              <input name="imapTlsPort" type="number" value="${escapeHtml(config.server.imap.tlsPort)}" required>
            </div>
          </div>
          <div class="row">
            <div>
              <label>SMTP host</label>
              <input name="submissionHost" value="${escapeHtml(config.server.submission.host)}" required>
            </div>
            <div>
              <label>SMTP port</label>
              <input name="submissionPort" type="number" value="${escapeHtml(config.server.submission.port)}" required>
            </div>
            <div>
              <label>SMTPS port</label>
              <input name="submissionTlsPort" type="number" value="${escapeHtml(config.server.submission.tlsPort)}" required>
            </div>
          </div>
          <label>SMTP hostname override</label>
          <input name="smtpHostnameOverride" value="${escapeHtml(smtpHostnameOverride)}" placeholder="Leave blank to use the global mail hostname">
          <div class="toggle-grid">
            <div class="toggle-row">
              <div class="toggle-label">POP3</div>
              <label class="toggle-cell"><input name="pop3AllowPlaintext" type="checkbox" ${config.server.pop3.allowPlaintext ? "checked" : ""}><span>Allow plaintext login</span></label>
              <label class="toggle-cell disabled"><input name="pop3EnableStartTls" type="checkbox" ${config.server.pop3.enableStartTls ? "checked" : ""} disabled><span>Enable STLS</span></label>
              <label class="toggle-cell"><input name="pop3EnableTls" type="checkbox" ${config.server.pop3.enableTls ? "checked" : ""}><span>Enable implicit TLS</span></label>
            </div>
            <div class="toggle-row">
              <div class="toggle-label">IMAP</div>
              <label class="toggle-cell"><input name="imapAllowPlaintext" type="checkbox" ${config.server.imap.allowPlaintext ? "checked" : ""}><span>Allow plaintext login</span></label>
              <label class="toggle-cell disabled"><input name="imapEnableStartTls" type="checkbox" ${config.server.imap.enableStartTls ? "checked" : ""} disabled><span>Enable STARTTLS</span></label>
              <label class="toggle-cell"><input name="imapEnableTls" type="checkbox" ${config.server.imap.enableTls ? "checked" : ""}><span>Enable implicit TLS</span></label>
            </div>
            <div class="toggle-row">
              <div class="toggle-label">SMTP</div>
              <label class="toggle-cell"><input name="smtpAllowPlaintext" type="checkbox" ${config.server.smtp.allowPlaintext ? "checked" : ""}><span>Allow plaintext inbound</span></label>
              <label class="toggle-cell disabled"><input name="smtpEnableStartTls" type="checkbox" ${config.server.smtp.enableStartTls ? "checked" : ""} disabled><span>Enable STARTTLS</span></label>
              <div class="toggle-cell"></div>
            </div>
            <div class="toggle-row">
              <div class="toggle-label">SMTPS</div>
              <label class="toggle-cell"><input name="submissionAllowPlaintext" type="checkbox" ${config.server.submission.allowPlaintext ? "checked" : ""}><span>Allow plaintext auth</span></label>
              <label class="toggle-cell disabled"><input name="submissionEnableStartTls" type="checkbox" ${config.server.submission.enableStartTls ? "checked" : ""} disabled><span>Enable STARTTLS</span></label>
              <label class="toggle-cell"><input name="submissionEnableTls" type="checkbox" ${config.server.submission.enableTls ? "checked" : ""}><span>Enable implicit TLS</span></label>
            </div>
          </div>
          <h3 class="section-heading">Outbound Delivery</h3>
          <div class="row">
            <div>
              <label>Outbound EHLO hostname override</label>
              <input name="outboundGreetingHostnameOverride" value="${escapeHtml(outboundGreetingHostnameOverride)}" placeholder="Leave blank to use the SMTP/global hostname">
            </div>
            <div>
              <label>Outbound connect timeout (ms)</label>
              <input name="outboundConnectTimeoutMs" type="number" value="${escapeHtml(config.outbound.connectTimeoutMs)}" required>
            </div>
          </div>
          <div class="inline"><input name="outboundPreferStartTls" type="checkbox" ${config.outbound.preferStartTls ? "checked" : ""}><span>Prefer STARTTLS for outbound delivery</span></div>
          <label>TLS certificate path</label>
          <input name="tlsCertFile" value="${escapeHtml(config.tls.certFile)}" required>
          <label>TLS key path</label>
          <input name="tlsKeyFile" value="${escapeHtml(config.tls.keyFile)}" required>
          <div class="row">
            <div>
              <label>Max message bytes</label>
              <input name="maxMessageBytes" type="number" value="${escapeHtml(config.limits.maxMessageBytes)}" required>
            </div>
            <div>
              <label>Max recipients per message</label>
              <input name="maxRecipientsPerMessage" type="number" value="${escapeHtml(config.limits.maxRecipientsPerMessage)}" required>
            </div>
            <div>
              <label>Max mailbox bytes</label>
              <input name="maxMailboxBytes" type="number" value="${escapeHtml(config.limits.maxMailboxBytes)}" required>
            </div>
          </div>
          <div class="row">
            <div>
              <label>Socket timeout (ms)</label>
              <input name="socketTimeoutMs" type="number" value="${escapeHtml(config.limits.socketTimeoutMs)}" required>
            </div>
            <div>
              <label>Max invalid auth attempts</label>
              <input name="maxInvalidAuthAttempts" type="number" value="${escapeHtml(config.limits.maxInvalidAuthAttempts)}" required>
            </div>
          </div>
          <label>Storage root</label>
          <input name="storageRootDir" value="${escapeHtml(config.storage.rootDir)}" required>
          <h3 class="section-heading spacious">Admin UI</h3>
          <div class="row">
            <div>
              <label>Admin host</label>
              <input name="adminHost" value="${escapeHtml(config.admin?.host ?? "0.0.0.0")}" required>
            </div>
            <div>
              <label>Admin port</label>
              <input name="adminPort" type="number" value="${escapeHtml(config.admin?.port ?? 80)}" required>
            </div>
          </div>
          <div class="inline"><input name="adminEnableTls" type="checkbox" ${config.admin?.enableTls ? "checked" : ""}><span>Enable HTTPS for the admin listener</span></div>
          <div class="inline"><input name="adminLogRequests" type="checkbox" ${config.admin?.logRequests ? "checked" : ""}><span>Log all admin route requests and response codes</span></div>
          <label>New admin password</label>
          <input name="adminPassword" type="password" placeholder="Leave blank to keep the current admin password">
          <div class="actions">
            <button type="submit">Save global settings</button>
          </div>
        </form>
      </div>
    </section>
    <section class="tab-panel" data-tab-panel="domains">
      <div class="card">
        <h2>Domains</h2>
        <p>These are the local domains this server accepts mail for.</p>
        <form method="post" action="/config/domains">
          <label>Hosted domains</label>
          <textarea name="domains" required>${escapeHtml(config.domains.join("\n"))}</textarea>
          <div class="actions">
            <button type="submit">Save domains</button>
          </div>
        </form>
      </div>
    </section>
    <section class="tab-panel" data-tab-panel="users">
      <div class="grid">
        <section class="card">
        <h2>Users</h2>
        <p>Each user can own one mailbox and multiple recipient addresses.</p>
        <div class="users">
          ${usersHtml}
        </div>
        </section>
        <section class="card">
        <h2>Add User</h2>
        <form method="post" action="/users/save">
          <div class="row">
            <div>
              <label>Username</label>
              <input name="username" required>
            </div>
            <div>
              <label>Mailbox</label>
              <input name="mailbox" required>
            </div>
          </div>
          <label>Addresses</label>
          <textarea name="addresses" placeholder="alice@example.com&#10;support@example.com" required></textarea>
          <h3 class="section-heading spacious">Newsletter</h3>
          <div class="inline"><input name="newsletterEnabled" type="checkbox"><span>Enable newsletter after saving</span></div>
          <label>Newsletter address</label>
          <input name="newsletterAddress" placeholder="Must match one address above">
          <label>Newsletter title</label>
          <input name="newsletterTitle" placeholder="Newsletter">
          <div class="inline"><input name="newsletterPublicSubscription" type="checkbox"><span>Allow public subscribe</span></div>
          <div class="inline"><input name="newsletterPublicUnsubscribe" type="checkbox"><span>Allow public unsubscribe</span></div>
          <div class="row">
            <div>
              <label>Password</label>
              <input name="password" type="password">
            </div>
            <div>
              <label>Or password hash</label>
              <input name="passwordHash">
            </div>
          </div>
          <div class="actions">
            <button type="submit">Create user</button>
          </div>
        </form>
        </section>
      </div>
    </section>`;

  return renderLayout(`${APP_DISPLAY_NAME} Admin`, body, flash);
}

function renderPublicListPage(user, mode, flash = "") {
  const newsletter = user.newsletter;
  const isSubscribe = mode === "subscribe";
  const headingPrefix = isSubscribe ? "Subscribe to:" : "Unsubscribe from:";
  const action = `/lists/${encodeURIComponent(user.mailbox)}/${mode}`;
  const form = isSubscribe
    ? `<form method="post" action="/lists/${encodeURIComponent(user.mailbox)}/subscribe">
        <label>Email address</label>
        <input name="email" type="email" required>
        <div class="actions">
          <button type="submit">Subscribe</button>
        </div>
      </form>`
    : `<form method="post" action="${action}">
        <label>Email address</label>
        <input name="email" type="email" required>
        <div class="actions">
          <button class="subtle" type="submit">Unsubscribe</button>
        </div>
      </form>`;

  return renderLayout(
    newsletter.title,
    `<div class="card" style="max-width: 520px; margin: 80px auto 0;">
      <p style="margin: 0 0 4px; font-size: 14px;">${headingPrefix}</p>
      <h1>${escapeHtml(newsletter.title)}</h1>
      ${form}
    </div>`,
    flash
  );
}

function renderPublicMessage(title, message) {
  return renderLayout(
    title,
    `<div class="card" style="max-width: 520px; margin: 80px auto 0;">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </div>`
  );
}

export class AdminUiServer {
  constructor(config, onConfigUpdated, log, tlsMaterial, deps = {}) {
    this.config = config;
    this.onConfigUpdated = onConfigUpdated;
    this.log = log;
    this.tlsMaterial = tlsMaterial;
    this.sendListMessage = deps.sendListMessage ?? (async () => {});
    this.server = undefined;
    this.sessions = new Map();
  }

  get enabled() {
    return isAdminEnabled(this.config);
  }

  async start() {
    if (!this.enabled) {
      return;
    }

    if (this.config.admin?.enableTls) {
      if (!this.tlsMaterial) {
        throw new Error("Admin HTTPS is enabled but TLS material is unavailable");
      }

      this.server = https.createServer(
        {
          cert: this.tlsMaterial.cert,
          key: this.tlsMaterial.key
        },
        (request, response) => {
          void this.handleRequest(request, response);
        }
      );
    } else {
      this.server = http.createServer((request, response) => {
        void this.handleRequest(request, response);
      });
    }

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("error", onError);
        const wrapped = new Error(`Failed to listen on ${this.config.admin.host}:${this.config.admin.port}: ${error.message}`);
        wrapped.code = error.code;
        wrapped.cause = error;
        reject(wrapped);
      };

      this.server.once("error", onError);
      this.server.listen(this.config.admin.port, this.config.admin.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });

    this.log.info("admin.started", {
      adminHost: this.config.admin.host,
      adminPort: this.config.admin.port,
      adminTls: this.config.admin.enableTls
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  updateConfig(config) {
    const previousFingerprint = authFingerprint(this.config.admin);
    this.config = config;
    if (!timingSafeEqual(Buffer.from(previousFingerprint), Buffer.from(authFingerprint(config.admin)))) {
      this.sessions.clear();
    }
  }

  updateTlsMaterial(tlsMaterial) {
    this.tlsMaterial = tlsMaterial;
    if (this.config.admin?.enableTls && this.server?.setSecureContext && tlsMaterial) {
      this.server.setSecureContext(tlsMaterial);
    }
  }

  publicBaseUrl(request) {
    const protocol = this.config.admin?.enableTls ? "https" : "http";
    const host = request.headers.host ?? this.config.hostname;
    return `${protocol}://${host}`;
  }

  findPublicNewsletter(mailbox) {
    return findNewsletterByMailbox(this.config.users, decodeURIComponent(mailbox));
  }

  async sendNewsletterNotice(user, to, subject, text, baseUrl = null) {
    const rawMessage = buildEmailMessage({
      from: user.newsletter.address,
      to,
      subject,
      text,
      hostname: this.config.server.smtp.hostname,
      headers: baseUrl
        ? {
            "List-Id": `<${user.mailbox}.${user.newsletter.address.split("@")[1]}>`,
            "List-Unsubscribe": `<${buildPublicListUrl(baseUrl, user)}/unsubscribe>`
          }
        : {}
    });
    await this.sendListMessage(to, rawMessage, user.newsletter.address);
  }

  async notifyOwner(user, subject, text) {
    const ownerAddress = user.addresses[0];
    if (!ownerAddress) {
      return;
    }
    await this.sendNewsletterNotice(user, ownerAddress, subject, text);
  }

  async migrateAdminPasswordIfNeeded() {
    if (!this.config.admin?.password) {
      return;
    }

    const nextConfig = {
      ...this.config,
      admin: {
        ...this.config.admin,
        password: "",
        passwordHash: await Bun.password.hash(this.config.admin.password)
      }
    };

    await saveConfig(nextConfig);
    this.onConfigUpdated(nextConfig);
  }

  isAuthenticated(request) {
    const cookies = parseCookie(request.headers.cookie);
    const token = cookies.postofficex_admin;
    return token && this.sessions.has(token);
  }

  async readForm(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  setFlashCookie(response, message) {
    response.setHeader("Set-Cookie", `postofficex_flash=${encodeURIComponent(message)}; ${adminCookieAttributes(this.config.admin)}`);
  }

  sendResponse(request, response, statusCode, headers, body = "") {
    response.writeHead(statusCode, headers);
    response.end(body);

    const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    if (this.config.admin?.logRequests && path !== "/ping" && statusCode !== 404) {
      this.log.info("admin.request", {
        method: request.method ?? "GET",
        path,
        statusCode
      });
    }
  }

  consumeFlash(request, response) {
    const cookies = parseCookie(request.headers.cookie);
    const flash = cookies.postofficex_flash ? decodeURIComponent(cookies.postofficex_flash) : "";
    if (flash) {
      response.setHeader("Set-Cookie", `postofficex_flash=; ${adminCookieAttributes(this.config.admin)}; Max-Age=0`);
    }
    return flash;
  }

  async handleRequest(request, response) {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const flash = this.consumeFlash(request, response);
    const isPublicRoute = isAdminPublicRoute(url.pathname, method);
    const isAuthenticatedRoute = isAdminAuthenticatedRoute(url.pathname, method);

    if (!isPublicRoute && !isAuthenticatedRoute) {
      this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }

    if (url.pathname === "/ping" && method === "GET") {
      this.sendResponse(
        request,
        response,
        200,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({ status: "OK", name: APP_NAME, version: APP_VERSION })
      );
      return;
    }

    if (url.pathname === "/login" && method === "GET") {
      this.sendResponse(
        request,
        response,
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        renderLoginPage(flash)
      );
      return;
    }

    if (url.pathname === "/login" && method === "POST") {
      const form = await this.readForm(request);
      const password = form.get("password") ?? "";
      const valid = await verifyAdminPassword(password, this.config.admin);
      if (!valid) {
        this.sendResponse(
          request,
          response,
          401,
          { "Content-Type": "text/html; charset=utf-8" },
          renderLoginPage("Invalid admin password.")
        );
        return;
      }

      await this.migrateAdminPasswordIfNeeded();

      const token = randomUUID();
      this.sessions.set(token, {
        fingerprint: authFingerprint(this.config.admin)
      });
      this.sendResponse(request, response, 302, {
        Location: "/",
        "Set-Cookie": `postofficex_admin=${token}; ${adminCookieAttributes(this.config.admin)}`
      });
      return;
    }

    const publicListMatch = url.pathname.match(/^\/lists\/([^/]+)$/);
    if (publicListMatch && method === "GET") {
      const user = this.findPublicNewsletter(publicListMatch[1]);
      if (!user || (!user.newsletter.publicSubscription && !user.newsletter.publicUnsubscribe)) {
        this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }
      redirect(
        response,
        `/lists/${encodeURIComponent(user.mailbox)}/${user.newsletter.publicSubscription ? "subscribe" : "unsubscribe"}`
      );
      return;
    }

    const subscribeMatch = url.pathname.match(/^\/lists\/([^/]+)\/subscribe$/);
    if (subscribeMatch && method === "GET") {
      const user = this.findPublicNewsletter(subscribeMatch[1]);
      if (!user || !user.newsletter.publicSubscription) {
        this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }
      this.sendResponse(
        request,
        response,
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        renderPublicListPage(user, "subscribe", flash)
      );
      return;
    }

    if (subscribeMatch && method === "POST") {
      const user = this.findPublicNewsletter(subscribeMatch[1]);
      if (!user || !user.newsletter.publicSubscription) {
        this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }

      const form = await this.readForm(request);
      try {
        const result = beginSubscription(user, form.get("email") ?? "");
        await saveConfig(this.config);
        this.onConfigUpdated(this.config);
        if (result.status === "pending") {
          const confirmUrl = buildConfirmUrl(this.publicBaseUrl(request), user, result.email, result.confirmationToken);
          const unsubscribeUrl = buildUnsubscribeUrl(this.publicBaseUrl(request), user, result.email, result.unsubscribeToken);
          await this.sendNewsletterNotice(
            user,
            result.email,
            `Confirm your subscription to ${user.newsletter.title}`,
            `Confirm your subscription by opening this link:\n\n${confirmUrl}\n\nAfter confirming, you can unsubscribe with this link:\n\n${unsubscribeUrl}\n\nIf you did not request this, ignore this message.`,
            this.publicBaseUrl(request)
          );
        }
        this.sendResponse(
          request,
          response,
          200,
          { "Content-Type": "text/html; charset=utf-8" },
          renderPublicMessage(user.newsletter.title, "Check your email to confirm the subscription.")
        );
      } catch (error) {
        this.sendResponse(
          request,
          response,
          400,
          { "Content-Type": "text/html; charset=utf-8" },
          renderPublicListPage(user, "subscribe", error instanceof Error ? error.message : "Subscription failed.")
        );
      }
      return;
    }

    const confirmMatch = url.pathname.match(/^\/lists\/([^/]+)\/confirm$/);
    if (confirmMatch && method === "GET") {
      const user = this.findPublicNewsletter(confirmMatch[1]);
      if (!user) {
        this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }

      const email = url.searchParams.get("email") ?? "";
      const result = confirmSubscription(user, email, url.searchParams.get("token") ?? "");
      await saveConfig(this.config);
      this.onConfigUpdated(this.config);
      if (!result.ok) {
        this.sendResponse(
          request,
          response,
          400,
          { "Content-Type": "text/html; charset=utf-8" },
          renderPublicMessage(user.newsletter.title, "The confirmation link is invalid or expired.")
        );
        return;
      }

      await this.sendNewsletterNotice(
        user,
        result.email,
        `Subscribed to ${user.newsletter.title}`,
        `You are now subscribed to ${user.newsletter.title}.\n\nTo unsubscribe later, use ${buildPublicListUrl(this.publicBaseUrl(request), user)}/unsubscribe`,
        this.publicBaseUrl(request)
      );
      await this.notifyOwner(
        user,
        `New subscriber for ${user.newsletter.title}`,
        `${result.email} confirmed a subscription to ${user.newsletter.title}.`
      );
      this.sendResponse(
        request,
        response,
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        renderPublicMessage(user.newsletter.title, "Your subscription is confirmed.")
      );
      return;
    }

    const unsubscribeMatch = url.pathname.match(/^\/lists\/([^/]+)\/unsubscribe$/);
    if (unsubscribeMatch && method === "GET") {
      const user = this.findPublicNewsletter(unsubscribeMatch[1]);
      if (!user || !user.newsletter.publicUnsubscribe) {
        this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }

      const email = url.searchParams.get("email") ?? "";
      const token = url.searchParams.get("token");
      if (email && token) {
        const result = removeSubscriber(user, email, token);
        await saveConfig(this.config);
        this.onConfigUpdated(this.config);
        if (result.ok) {
          await this.sendNewsletterNotice(
            user,
            result.email,
            `Unsubscribed from ${user.newsletter.title}`,
            `You have been unsubscribed from ${user.newsletter.title}.`
          );
          await this.notifyOwner(
            user,
            `Subscriber removed from ${user.newsletter.title}`,
            `${result.email} unsubscribed from ${user.newsletter.title}.`
          );
        }
        this.sendResponse(
          request,
          response,
          result.ok ? 200 : 400,
          { "Content-Type": "text/html; charset=utf-8" },
          renderPublicMessage(user.newsletter.title, result.ok ? "You have been unsubscribed." : "The unsubscribe link is invalid.")
        );
        return;
      }

      this.sendResponse(
        request,
        response,
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        renderPublicListPage(user, "unsubscribe")
      );
      return;
    }

    if (unsubscribeMatch && method === "POST") {
      const user = this.findPublicNewsletter(unsubscribeMatch[1]);
      if (!user || !user.newsletter.publicUnsubscribe) {
        this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }

      const form = await this.readForm(request);
      const email = `${form.get("email") ?? ""}`.trim().toLowerCase();
      const subscriber = findSubscriber(user, email);
      if (subscriber) {
        removeSubscriber(user, email);
        await saveConfig(this.config);
        this.onConfigUpdated(this.config);
        await this.sendNewsletterNotice(
          user,
          email,
          `Unsubscribed from ${user.newsletter.title}`,
          `You have been unsubscribed from ${user.newsletter.title}.`
        );
        await this.notifyOwner(
          user,
          `Subscriber removed from ${user.newsletter.title}`,
          `${email} unsubscribed from ${user.newsletter.title}.`
        );
      }
      this.sendResponse(
        request,
        response,
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        renderPublicMessage(user.newsletter.title, "If that address was subscribed, it has been removed.")
      );
      return;
    }

    if (!this.isAuthenticated(request)) {
      this.sendResponse(request, response, 302, { Location: "/login" });
      return;
    }

    if (url.pathname === "/" && method === "GET") {
      this.sendResponse(
        request,
        response,
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        renderAdminPage(this.config, flash)
      );
      return;
    }

    if (url.pathname === "/logout" && method === "POST") {
      const cookies = parseCookie(request.headers.cookie);
      if (cookies.postofficex_admin) {
        this.sessions.delete(cookies.postofficex_admin);
      }
      this.sendResponse(request, response, 302, {
        Location: "/login",
        "Set-Cookie": `postofficex_admin=; ${adminCookieAttributes(this.config.admin)}; Max-Age=0`
      });
      return;
    }

    if (url.pathname === "/config/global" && method === "POST") {
      const form = await this.readForm(request);
      const smtpHostnameOverride = form.get("smtpHostnameOverride")?.trim() ?? "";
      const outboundGreetingHostnameOverride = form.get("outboundGreetingHostnameOverride")?.trim() ?? "";
      const nextLocal = structuredClone(this.config.local ?? {});

      nextLocal.hostname = form.get("hostname")?.trim() || this.config.hostname;
      if (smtpHostnameOverride) {
        nextLocal.server = nextLocal.server ?? {};
        nextLocal.server.smtp = { ...(nextLocal.server.smtp ?? {}), hostname: smtpHostnameOverride };
      } else if (nextLocal.server?.smtp) {
        delete nextLocal.server.smtp.hostname;
        if (Object.keys(nextLocal.server.smtp).length === 0) {
          delete nextLocal.server.smtp;
        }
        if (Object.keys(nextLocal.server).length === 0) {
          delete nextLocal.server;
        }
      }

      if (outboundGreetingHostnameOverride) {
        nextLocal.outbound = {
          ...(nextLocal.outbound ?? {}),
          greetingHostname: outboundGreetingHostnameOverride
        };
      } else if (nextLocal.outbound) {
        delete nextLocal.outbound.greetingHostname;
        if (Object.keys(nextLocal.outbound).length === 0) {
          delete nextLocal.outbound;
        }
      }

      const nextConfig = {
        ...this.config,
        hostname: nextLocal.hostname,
        defaults: this.config.defaults,
        local: nextLocal,
        server: {
          smtp: {
            host: form.get("smtpHost")?.trim() || this.config.server.smtp.host,
            port: numberFromForm(form, "smtpPort", this.config.server.smtp.port),
            hostname: smtpHostnameOverride || nextLocal.hostname,
            allowPlaintext: boolFromForm(form, "smtpAllowPlaintext"),
            enableStartTls: boolFromForm(form, "smtpEnableStartTls")
          },
          submission: {
            host: form.get("submissionHost")?.trim() || this.config.server.submission.host,
            port: numberFromForm(form, "submissionPort", this.config.server.submission.port),
            tlsPort: numberFromForm(form, "submissionTlsPort", this.config.server.submission.tlsPort),
            allowPlaintext: boolFromForm(form, "submissionAllowPlaintext"),
            enableStartTls: boolFromForm(form, "submissionEnableStartTls"),
            enableTls: boolFromForm(form, "submissionEnableTls")
          },
          pop3: {
            host: form.get("pop3Host")?.trim() || this.config.server.pop3.host,
            port: numberFromForm(form, "pop3Port", this.config.server.pop3.port),
            tlsPort: numberFromForm(form, "pop3TlsPort", this.config.server.pop3.tlsPort),
            allowPlaintext: boolFromForm(form, "pop3AllowPlaintext"),
            enableStartTls: boolFromForm(form, "pop3EnableStartTls"),
            enableTls: boolFromForm(form, "pop3EnableTls")
          },
          imap: {
            host: form.get("imapHost")?.trim() || this.config.server.imap.host,
            port: numberFromForm(form, "imapPort", this.config.server.imap.port),
            tlsPort: numberFromForm(form, "imapTlsPort", this.config.server.imap.tlsPort),
            allowPlaintext: boolFromForm(form, "imapAllowPlaintext"),
            enableStartTls: boolFromForm(form, "imapEnableStartTls"),
            enableTls: boolFromForm(form, "imapEnableTls")
          }
        },
        outbound: {
          greetingHostname: outboundGreetingHostnameOverride || smtpHostnameOverride || nextLocal.hostname,
          connectTimeoutMs: numberFromForm(
            form,
            "outboundConnectTimeoutMs",
            this.config.outbound.connectTimeoutMs
          ),
          preferStartTls: boolFromForm(form, "outboundPreferStartTls")
        },
        tls: {
          certFile: form.get("tlsCertFile")?.trim() || this.config.tls.certFile,
          keyFile: form.get("tlsKeyFile")?.trim() || this.config.tls.keyFile
        },
        limits: {
          maxMessageBytes: numberFromForm(form, "maxMessageBytes", this.config.limits.maxMessageBytes),
          maxRecipientsPerMessage: numberFromForm(form, "maxRecipientsPerMessage", this.config.limits.maxRecipientsPerMessage),
          maxMailboxBytes: numberFromForm(form, "maxMailboxBytes", this.config.limits.maxMailboxBytes),
          socketTimeoutMs: numberFromForm(form, "socketTimeoutMs", this.config.limits.socketTimeoutMs),
          maxInvalidAuthAttempts: numberFromForm(form, "maxInvalidAuthAttempts", this.config.limits.maxInvalidAuthAttempts)
        },
        storage: {
          rootDir: form.get("storageRootDir")?.trim() || this.config.storage.rootDir
        },
        domains: this.config.domains,
        admin: {
          host: form.get("adminHost")?.trim() || this.config.admin.host,
          port: numberFromForm(form, "adminPort", this.config.admin.port),
          enableTls: boolFromForm(form, "adminEnableTls"),
          logRequests: boolFromForm(form, "adminLogRequests"),
          password: this.config.admin.password,
          passwordHash: this.config.admin.passwordHash
        }
      };

      const adminPassword = form.get("adminPassword")?.trim() ?? "";
      if (adminPassword) {
        nextConfig.admin.password = "";
        nextConfig.admin.passwordHash = await Bun.password.hash(adminPassword);
      }

      await saveConfig(nextConfig);
      this.onConfigUpdated(nextConfig);
      this.setFlashCookie(response, "Global settings saved. Listener host, port, and TLS changes may require a restart.");
      redirect(response, "/");
      return;
    }

    if (url.pathname === "/config/domains" && method === "POST") {
      const form = await this.readForm(request);
      const nextConfig = {
        ...this.config,
        domains: parseDomains(form.get("domains") ?? "")
      };
      await saveConfig(nextConfig);
      this.onConfigUpdated(nextConfig);
      this.setFlashCookie(response, "Domains saved.");
      redirect(response, "/");
      return;
    }

    if (url.pathname === "/users/save" && method === "POST") {
      const form = await this.readForm(request);
      const username = (form.get("username") ?? "").trim().toLowerCase();
      const mailbox = (form.get("mailbox") ?? "").trim().toLowerCase();
      const addresses = parseAddressList(form.get("addresses") ?? "");
      const originalUsername = (form.get("originalUsername") ?? "").trim().toLowerCase();

      if (!username || !mailbox || addresses.length === 0) {
        this.setFlashCookie(response, "Username, mailbox, and at least one address are required.");
        redirect(response, "/");
        return;
      }

      const existingUser =
        this.config.users.find((user) => user.username === originalUsername) ??
        this.config.users.find((user) => user.username === username);

      let passwordHash = existingUser?.passwordHash ?? "";
      const password = (form.get("password") ?? "").trim();
      const providedHash = (form.get("passwordHash") ?? "").trim();
      if (password) {
        passwordHash = await Bun.password.hash(password);
      } else if (providedHash) {
        passwordHash = providedHash;
      }

      if (!passwordHash) {
        this.setFlashCookie(response, "Each user requires a password or password hash.");
        redirect(response, "/");
        return;
      }

      const newsletterEnabled = boolFromForm(form, "newsletterEnabled");
      const newsletterAddress = (form.get("newsletterAddress") ?? "").trim().toLowerCase() || addresses[0];
      if (newsletterEnabled && !addresses.includes(newsletterAddress)) {
        this.setFlashCookie(response, "Newsletter address must match one of the user's addresses.");
        redirect(response, "/");
        return;
      }

      const nextUser = {
        username,
        mailbox,
        passwordHash,
        addresses
      };
      if (newsletterEnabled || existingUser?.newsletter) {
        nextUser.newsletter = {
          enabled: newsletterEnabled,
          address: newsletterAddress,
          title: (form.get("newsletterTitle") ?? "").trim() || `${username} newsletter`,
          publicSubscription: boolFromForm(form, "newsletterPublicSubscription"),
          publicUnsubscribe: boolFromForm(form, "newsletterPublicUnsubscribe"),
          subscribers: existingUser?.newsletter?.subscribers ?? [],
          pendingSubscriptions: existingUser?.newsletter?.pendingSubscriptions ?? []
        };
      }

      const nextUsers = this.config.users.filter((user) => user.username !== originalUsername && user.username !== username);
      nextUsers.push(nextUser);
      nextUsers.sort((a, b) => a.username.localeCompare(b.username));

      const nextConfig = {
        ...this.config,
        users: nextUsers
      };

      await saveConfig(nextConfig);
      this.onConfigUpdated(nextConfig);
      this.setFlashCookie(response, `User ${username} saved.`);
      redirect(response, "/");
      return;
    }

    if (url.pathname === "/users/delete" && method === "POST") {
      const form = await this.readForm(request);
      const username = (form.get("username") ?? "").trim().toLowerCase();
      const nextConfig = {
        ...this.config,
        users: this.config.users.filter((user) => user.username !== username)
      };
      await saveConfig(nextConfig);
      this.onConfigUpdated(nextConfig);
      this.setFlashCookie(response, `User ${username} deleted.`);
      redirect(response, "/");
      return;
    }

    this.sendResponse(request, response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
  }
}
