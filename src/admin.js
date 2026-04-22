import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { saveConfig } from "./config.js";
import { buildUserDirectory } from "./config.js";

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
    (pathname === "/login" && (method === "GET" || method === "POST"))
  );
}

function isAdminAuthenticatedRoute(pathname, method) {
  return (
    (pathname === "/" && method === "GET") ||
    (pathname === "/logout" && method === "POST") ||
    (pathname === "/config/global" && method === "POST") ||
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
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: linear-gradient(180deg, #efe5d7 0%, var(--bg) 100%); color: var(--ink); }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
    h1, h2, h3 { margin: 0 0 12px; font-weight: 600; }
    p { color: var(--muted); }
    .flash { margin-bottom: 16px; padding: 12px 14px; background: #fff3cd; border: 1px solid #f0d98b; border-radius: 10px; }
    .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(50, 35, 10, 0.06); }
    label { display: block; margin: 12px 0 6px; font-size: 14px; color: var(--muted); }
    input, textarea { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: white; font: inherit; }
    textarea { min-height: 88px; resize: vertical; }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .inline { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .inline input { width: auto; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    button { border: 0; border-radius: 999px; padding: 10px 16px; font: inherit; background: var(--accent); color: white; cursor: pointer; }
    button.secondary { background: #4b5d67; }
    button.subtle { background: #8a877f; }
    .users { display: grid; gap: 16px; }
    .user { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--soft); }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
    .mono { font-family: "Courier New", monospace; }
  </style>
</head>
<body>
  <div class="wrap">
    ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}
    ${body}
  </div>
</body>
</html>`;
}

function renderLoginPage(flash = "") {
  return renderLayout(
    "PostOfficeX Admin",
    `<div class="card" style="max-width: 420px; margin: 80px auto 0;">
      <h1>PostOfficeX Admin</h1>
      <p>Sign in to manage global server settings and mail users.</p>
      <form method="post" action="/login">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" required>
        <div class="actions">
          <button type="submit">Sign in</button>
        </div>
      </form>
    </div>`,
    flash
  );
}

function renderUserEditor(user) {
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
  const body = `<div class="topbar">
      <div>
        <h1>PostOfficeX Admin</h1>
        <p>Admin UI changes are written back to <span class="mono">${escapeHtml(config.configPath)}</span>.<br>Listener host, port, and TLS material changes may require a restart.</p>
      </div>
      <form method="post" action="/logout">
        <button class="secondary" type="submit">Log out</button>
      </form>
    </div>
    <div class="grid">
      <section class="card">
        <h2>Global Settings</h2>
        <form method="post" action="/config/global">
          <div class="row">
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
              <label>Submission host</label>
              <input name="submissionHost" value="${escapeHtml(config.server.submission.host)}" required>
            </div>
            <div>
              <label>Submission port</label>
              <input name="submissionPort" type="number" value="${escapeHtml(config.server.submission.port)}" required>
            </div>
            <div>
              <label>Submission TLS port</label>
              <input name="submissionTlsPort" type="number" value="${escapeHtml(config.server.submission.tlsPort)}" required>
            </div>
          </div>
          <label>SMTP hostname</label>
          <input name="smtpHostname" value="${escapeHtml(config.server.smtp.hostname)}" required>
          <div class="inline"><input name="smtpAllowPlaintext" type="checkbox" ${config.server.smtp.allowPlaintext ? "checked" : ""}><span>Allow plaintext SMTP</span></div>
          <div class="inline"><input name="smtpEnableStartTls" type="checkbox" ${config.server.smtp.enableStartTls ? "checked" : ""}><span>Enable SMTP STARTTLS</span></div>
          <div class="inline"><input name="submissionAllowPlaintext" type="checkbox" ${config.server.submission.allowPlaintext ? "checked" : ""}><span>Allow plaintext authenticated submission</span></div>
          <div class="inline"><input name="submissionEnableStartTls" type="checkbox" ${config.server.submission.enableStartTls ? "checked" : ""}><span>Enable submission STARTTLS</span></div>
          <div class="inline"><input name="submissionEnableTls" type="checkbox" ${config.server.submission.enableTls ? "checked" : ""}><span>Enable implicit TLS submission</span></div>
          <div class="inline"><input name="pop3AllowPlaintext" type="checkbox" ${config.server.pop3.allowPlaintext ? "checked" : ""}><span>Allow plaintext POP3 login</span></div>
          <div class="inline"><input name="pop3EnableTls" type="checkbox" ${config.server.pop3.enableTls ? "checked" : ""}><span>Enable POP3 TLS</span></div>
          <h3>Outbound Delivery</h3>
          <div class="row">
            <div>
              <label>Outbound EHLO hostname</label>
              <input name="outboundGreetingHostname" value="${escapeHtml(config.outbound.greetingHostname)}" required>
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
          <label>Hosted domains</label>
          <textarea name="domains" required>${escapeHtml(config.domains.join("\n"))}</textarea>
          <h3>Admin UI</h3>
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
      </section>
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
    </div>`;

  return renderLayout("PostOfficeX Admin", body, flash);
}

export class AdminUiServer {
  constructor(config, onConfigUpdated, log, tlsMaterial) {
    this.config = config;
    this.onConfigUpdated = onConfigUpdated;
    this.log = log;
    this.tlsMaterial = tlsMaterial;
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
        JSON.stringify({ status: "OK", name: "postofficex" })
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
      const nextConfig = {
        ...this.config,
        server: {
          smtp: {
            host: form.get("smtpHost")?.trim() || this.config.server.smtp.host,
            port: numberFromForm(form, "smtpPort", this.config.server.smtp.port),
            hostname: form.get("smtpHostname")?.trim() || this.config.server.smtp.hostname,
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
            enableTls: boolFromForm(form, "pop3EnableTls")
          }
        },
        outbound: {
          greetingHostname: form.get("outboundGreetingHostname")?.trim() || this.config.outbound.greetingHostname,
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
        domains: parseDomains(form.get("domains") ?? ""),
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

      const nextUsers = this.config.users.filter((user) => user.username !== originalUsername && user.username !== username);
      nextUsers.push({
        username,
        mailbox,
        passwordHash,
        addresses
      });
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
