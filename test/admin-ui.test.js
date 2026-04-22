import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { PostOfficeServer } from "../src/server.js";
import { MailboxStore } from "../src/storage.js";

let activeServer = null;

function httpsRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method,
        headers,
        rejectUnauthorized: false
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function setupAdminServer({
  plaintextAdminPassword = false,
  adminLogRequests = false,
  adminEnableTls = false,
  log = undefined
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "postofficex-admin-"));
  const userPasswordHash = await Bun.password.hash("secret123");
  const adminPasswordHash = plaintextAdminPassword ? "" : await Bun.password.hash("adminpw");
  const smtpPort = await reservePort();
  const pop3Port = await reservePort();
  const pop3TlsPort = await reservePort();
  const adminPort = await reservePort();
  const config = {
    server: {
      smtp: {
        host: "127.0.0.1",
        port: smtpPort,
        hostname: "mail.test.local",
        allowPlaintext: true,
        enableStartTls: false
      },
      pop3: {
        host: "127.0.0.1",
        port: pop3Port,
        tlsPort: pop3TlsPort,
        allowPlaintext: true,
        enableTls: false
      }
    },
    tls: {
      certFile: join(process.cwd(), "certs", "server.crt"),
      keyFile: join(process.cwd(), "certs", "server.key")
    },
    limits: {
      maxMessageBytes: 1024 * 1024,
      maxRecipientsPerMessage: 5,
      maxMailboxBytes: 1024 * 1024 * 10,
      socketTimeoutMs: 30000,
      maxInvalidAuthAttempts: 3
    },
    storage: {
      rootDir: "./data"
    },
    admin: {
      host: "127.0.0.1",
      port: adminPort,
      enableTls: adminEnableTls,
      logRequests: adminLogRequests,
      password: plaintextAdminPassword ? "adminpw" : "",
      passwordHash: adminPasswordHash
    },
    domains: ["example.test"],
    users: [
      {
        username: "alice",
        mailbox: "alice",
        passwordHash: userPasswordHash,
        addresses: ["alice@example.test"]
      }
    ]
  };

  const configPath = join(rootDir, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const resolved = await loadConfig(configPath);
  const server = new PostOfficeServer(resolved, new MailboxStore(resolved), log);
  await server.start();
  return { server, rootDir, configPath, adminPort };
}

afterEach(async () => {
  if (activeServer) {
    await activeServer.server.stop();
    activeServer = null;
  }
});

describe("admin ui", () => {
  test("serves /ping without authentication", async () => {
    activeServer = await setupAdminServer();

    const response = await fetch(`http://127.0.0.1:${activeServer.adminPort}/ping`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "OK", name: "postofficex" });
  });

  test("serves /ping over https when admin tls is enabled", async () => {
    activeServer = await setupAdminServer({ adminEnableTls: true });

    const response = await httpsRequest(`https://127.0.0.1:${activeServer.adminPort}/ping`);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({ status: "OK", name: "postofficex" });
  });

  test("logs admin requests when request logging is enabled but skips /ping", async () => {
    const logEntries = [];
    const log = {
      info(event, fields) {
        logEntries.push({ level: "info", event, fields });
      },
      warn() {},
      error() {}
    };

    activeServer = await setupAdminServer({ adminLogRequests: true, log });

    const ping = await fetch(`http://127.0.0.1:${activeServer.adminPort}/ping`);
    expect(ping.status).toBe(200);

    const loginPage = await fetch(`http://127.0.0.1:${activeServer.adminPort}/login`);
    expect(loginPage.status).toBe(200);

    const requestLog = logEntries.find((entry) => entry.event === "admin.request");
    expect(requestLog).toBeTruthy();
    expect(requestLog.fields).toEqual({
      method: "GET",
      path: "/login",
      statusCode: 200
    });
    expect(logEntries.some((entry) => entry.event === "admin.request" && entry.fields.path === "/ping")).toBe(false);
  });

  test("requires login and renders dashboard after authentication", async () => {
    activeServer = await setupAdminServer();

    const loginPage = await fetch(`http://127.0.0.1:${activeServer.adminPort}/login`);
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("PostOfficeX Admin");

    const login = await fetch(`http://127.0.0.1:${activeServer.adminPort}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      redirect: "manual",
      body: new URLSearchParams({ password: "adminpw" }).toString()
    });

    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("postofficex_admin=");

    const dashboard = await fetch(`http://127.0.0.1:${activeServer.adminPort}/`, {
      headers: {
        Cookie: cookie
      }
    });
    const html = await dashboard.text();
    expect(dashboard.status).toBe(200);
    expect(html).toContain("Global Settings");
    expect(html).toContain("Users");
  });

  test("saves global config and users through the admin ui", async () => {
    activeServer = await setupAdminServer();

    const login = await fetch(`http://127.0.0.1:${activeServer.adminPort}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      redirect: "manual",
      body: new URLSearchParams({ password: "adminpw" }).toString()
    });
    const cookie = login.headers.get("set-cookie");

    await fetch(`http://127.0.0.1:${activeServer.adminPort}/config/global`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie
      },
      redirect: "manual",
      body: new URLSearchParams({
        smtpHost: "127.0.0.1",
        smtpPort: "3526",
        smtpHostname: "mail.changed.test",
        smtpAllowPlaintext: "on",
        pop3Host: "127.0.0.1",
        pop3Port: "3111",
        pop3TlsPort: "3996",
        pop3AllowPlaintext: "on",
        tlsCertFile: "./missing.crt",
        tlsKeyFile: "./missing.key",
        maxMessageBytes: "1048576",
        maxRecipientsPerMessage: "8",
        maxMailboxBytes: "2097152",
        socketTimeoutMs: "45000",
        maxInvalidAuthAttempts: "4",
        storageRootDir: "./data",
        domains: "example.test\nexample.net",
        adminHost: "127.0.0.1",
        adminPort: String(activeServer.adminPort),
        adminEnableTls: "on",
        adminLogRequests: "on"
      }).toString()
    });

    await fetch(`http://127.0.0.1:${activeServer.adminPort}/users/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie
      },
      redirect: "manual",
      body: new URLSearchParams({
        username: "bob",
        mailbox: "bob",
        password: "bobpw",
        addresses: "bob@example.test\nsales@example.net"
      }).toString()
    });

    const saved = JSON.parse(await readFile(activeServer.configPath, "utf8"));
    expect(saved.server.smtp.hostname).toBe("mail.changed.test");
    expect(saved.domains).toEqual(["example.test", "example.net"]);
    expect(saved.admin.enableTls).toBe(true);
    expect(saved.admin.logRequests).toBe(true);
    expect(saved.users.some((user) => user.username === "bob")).toBe(true);
    expect(saved.users.find((user) => user.username === "bob").addresses).toEqual([
      "bob@example.test",
      "sales@example.net"
    ]);
  });

  test("rehashes a plaintext admin password after the first successful login", async () => {
    activeServer = await setupAdminServer({ plaintextAdminPassword: true });

    const login = await fetch(`http://127.0.0.1:${activeServer.adminPort}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      redirect: "manual",
      body: new URLSearchParams({ password: "adminpw" }).toString()
    });

    expect(login.status).toBe(302);

    const saved = JSON.parse(await readFile(activeServer.configPath, "utf8"));
    expect(saved.admin.password).toBe("");
    expect(saved.admin.passwordHash).toBeTruthy();
    expect(await Bun.password.verify("adminpw", saved.admin.passwordHash)).toBe(true);
  });

  test("uses admin.password as an override and replaces an older admin hash after login", async () => {
    activeServer = await setupAdminServer();

    const original = JSON.parse(await readFile(activeServer.configPath, "utf8"));
    original.admin.password = "newadminpw";
    await writeFile(activeServer.configPath, JSON.stringify(original, null, 2), "utf8");

    activeServer.server.applyConfig(await loadConfig(activeServer.configPath));

    const rejectedOldPassword = await fetch(`http://127.0.0.1:${activeServer.adminPort}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      redirect: "manual",
      body: new URLSearchParams({ password: "adminpw" }).toString()
    });
    expect(rejectedOldPassword.status).toBe(401);

    const login = await fetch(`http://127.0.0.1:${activeServer.adminPort}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      redirect: "manual",
      body: new URLSearchParams({ password: "newadminpw" }).toString()
    });
    expect(login.status).toBe(302);

    const saved = JSON.parse(await readFile(activeServer.configPath, "utf8"));
    expect(saved.admin.password).toBe("");
    expect(await Bun.password.verify("newadminpw", saved.admin.passwordHash)).toBe(true);
    expect(await Bun.password.verify("adminpw", saved.admin.passwordHash)).toBe(false);
  });
});
