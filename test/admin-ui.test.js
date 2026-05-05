import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { PostOfficeServer } from "../src/server.js";
import { MailboxStore } from "../src/storage.js";
import { reservePort } from "./helpers.js";
import { APP_NAME, APP_VERSION } from "../src/version.js";

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

async function setupAdminServer({
  plaintextAdminPassword = false,
  adminLogRequests = false,
  adminEnableTls = false,
  log = undefined
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "postofficex-admin-"));
  const configDir = join(rootDir, "data");
  await mkdir(configDir, { recursive: true });
  const userPasswordHash = await Bun.password.hash("secret123");
  const adminPasswordHash = plaintextAdminPassword ? "" : await Bun.password.hash("adminpw");
  const smtpPort = await reservePort();
  const submissionPort = await reservePort();
  const submissionTlsPort = await reservePort();
  const pop3Port = await reservePort();
  const pop3TlsPort = await reservePort();
  const imapPort = await reservePort();
  const imapTlsPort = await reservePort();
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
      submission: {
        host: "127.0.0.1",
        port: submissionPort,
        tlsPort: submissionTlsPort,
        allowPlaintext: true,
        enableStartTls: false,
        enableTls: false
      },
      pop3: {
        host: "127.0.0.1",
        port: pop3Port,
        tlsPort: pop3TlsPort,
        allowPlaintext: true,
        enableStartTls: false,
        enableTls: false
      },
      imap: {
        host: "127.0.0.1",
        port: imapPort,
        tlsPort: imapTlsPort,
        allowPlaintext: false,
        enableStartTls: false,
        enableTls: false
      }
    },
    outbound: {
      greetingHostname: "mail.test.local",
      connectTimeoutMs: 30000,
      preferStartTls: false
    },
    tls: {
      certFile: join(process.cwd(), "data", "certs", "server.crt"),
      keyFile: join(process.cwd(), "data", "certs", "server.key")
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

  const configPath = join(configDir, "local.json");
  const configPaths = {
    defaults: join(configDir, "defaults.json"),
    local: configPath,
    users: join(configDir, "users.json")
  };
  await writeFile(
    configPaths.defaults,
    JSON.stringify(
      {
        server: config.server,
        outbound: config.outbound,
        tls: config.tls,
        limits: config.limits,
        storage: config.storage,
        admin: config.admin
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    configPaths.local,
    JSON.stringify({ hostname: config.server.smtp.hostname, domains: config.domains }, null, 2),
    "utf8"
  );
  await writeFile(configPaths.users, JSON.stringify(config.users, null, 2), "utf8");
  const resolved = await loadConfig(configPath);
  const server = new PostOfficeServer(resolved, new MailboxStore(resolved), log);
  await server.start();
  return { server, rootDir, configPath, configPaths, adminPort };
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
    expect(await response.json()).toEqual({ status: "OK", name: APP_NAME, version: APP_VERSION });
  });

  test("serves /ping over https when admin tls is enabled", async () => {
    activeServer = await setupAdminServer({ adminEnableTls: true });

    const response = await httpsRequest(`https://127.0.0.1:${activeServer.adminPort}/ping`);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({ status: "OK", name: APP_NAME, version: APP_VERSION });
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

  test("returns 404 for unknown unauthenticated paths and does not log them", async () => {
    const logEntries = [];
    const log = {
      info(event, fields) {
        logEntries.push({ level: "info", event, fields });
      },
      warn() {},
      error() {}
    };

    activeServer = await setupAdminServer({ adminLogRequests: true, log });

    const response = await fetch(`http://127.0.0.1:${activeServer.adminPort}/.env`, {
      redirect: "manual"
    });

    expect(response.status).toBe(404);
    expect(logEntries.some((entry) => entry.event === "admin.request" && entry.fields.path === "/.env")).toBe(false);
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
    expect(html).toContain(`Version ${APP_VERSION}`);
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
        hostname: "mail.changed.test",
        smtpHost: "127.0.0.1",
        smtpPort: "3526",
        smtpHostnameOverride: "",
        smtpAllowPlaintext: "on",
        submissionHost: "127.0.0.1",
        submissionPort: "3587",
        submissionTlsPort: "3465",
        submissionAllowPlaintext: "on",
        pop3Host: "127.0.0.1",
        pop3Port: "3111",
        pop3TlsPort: "3996",
        pop3AllowPlaintext: "on",
        imapHost: "127.0.0.1",
        imapPort: "3143",
        imapTlsPort: "3993",
        imapEnableTls: "on",
        outboundGreetingHostnameOverride: "",
        outboundConnectTimeoutMs: "45000",
        outboundPreferStartTls: "on",
        tlsCertFile: "./missing.crt",
        tlsKeyFile: "./missing.key",
        maxMessageBytes: "1048576",
        maxRecipientsPerMessage: "8",
        maxMailboxBytes: "2097152",
        socketTimeoutMs: "45000",
        maxInvalidAuthAttempts: "4",
        storageRootDir: "./data",
        adminHost: "127.0.0.1",
        adminPort: String(activeServer.adminPort),
        adminEnableTls: "on",
        adminLogRequests: "on"
      }).toString()
    });

    await fetch(`http://127.0.0.1:${activeServer.adminPort}/config/domains`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie
      },
      redirect: "manual",
      body: new URLSearchParams({
        domains: "example.test\nexample.net"
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

    const defaultsSaved = JSON.parse(await readFile(activeServer.configPaths.defaults, "utf8"));
    const localSaved = JSON.parse(await readFile(activeServer.configPaths.local, "utf8"));
    const usersSaved = JSON.parse(await readFile(activeServer.configPaths.users, "utf8"));
    expect(defaultsSaved.server.smtp.hostname).toBe("mail.test.local");
    expect(localSaved.hostname).toBe("mail.changed.test");
    expect(localSaved.server.submission.port).toBe(3587);
    expect(localSaved.server.submission.tlsPort).toBe(3465);
    expect(localSaved.server.imap.port).toBe(3143);
    expect(localSaved.server.imap.tlsPort).toBe(3993);
    expect(localSaved.server.imap.enableTls).toBe(true);
    expect(localSaved.domains).toEqual(["example.test", "example.net"]);
    expect(localSaved.outbound.connectTimeoutMs).toBe(45000);
    expect(localSaved.outbound.preferStartTls).toBe(true);
    expect(localSaved.admin.enableTls).toBe(true);
    expect(localSaved.admin.logRequests).toBe(true);
    expect(usersSaved.some((user) => user.username === "bob")).toBe(true);
    expect(usersSaved.find((user) => user.username === "bob").addresses).toEqual([
      "bob@example.test",
      "sales@example.net"
    ]);
  });

  test("writes layered config changes back to local.json and users.json", async () => {
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

    const dashboard = await fetch(`http://127.0.0.1:${activeServer.adminPort}/`, {
      headers: {
        Cookie: cookie
      }
    });
    const html = await dashboard.text();
    expect(html).toContain(activeServer.configPaths.defaults);
    expect(html).toContain(activeServer.configPaths.local);
    expect(html).toContain(activeServer.configPaths.users);

    await fetch(`http://127.0.0.1:${activeServer.adminPort}/config/global`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie
      },
      redirect: "manual",
      body: new URLSearchParams({
        hostname: "mail.changed.test",
        smtpHost: "127.0.0.1",
        smtpPort: "3526",
        smtpHostnameOverride: "",
        smtpAllowPlaintext: "on",
        submissionHost: "127.0.0.1",
        submissionPort: "3587",
        submissionTlsPort: "3465",
        submissionAllowPlaintext: "on",
        pop3Host: "127.0.0.1",
        pop3Port: "3111",
        pop3TlsPort: "3996",
        pop3AllowPlaintext: "on",
        imapHost: "127.0.0.1",
        imapPort: "3143",
        imapTlsPort: "3993",
        imapEnableTls: "on",
        outboundGreetingHostnameOverride: "",
        outboundConnectTimeoutMs: "45000",
        outboundPreferStartTls: "on",
        tlsCertFile: "./missing.crt",
        tlsKeyFile: "./missing.key",
        maxMessageBytes: "1048576",
        maxRecipientsPerMessage: "8",
        maxMailboxBytes: "2097152",
        socketTimeoutMs: "45000",
        maxInvalidAuthAttempts: "4",
        storageRootDir: "./data",
        adminHost: "127.0.0.1",
        adminPort: String(activeServer.adminPort),
        adminEnableTls: "on",
        adminLogRequests: "on"
      }).toString()
    });

    await fetch(`http://127.0.0.1:${activeServer.adminPort}/config/domains`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie
      },
      redirect: "manual",
      body: new URLSearchParams({
        domains: "example.test\nexample.net"
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
        mailbox: "shared",
        password: "bobpw",
        addresses: "bob@example.test\nsales@example.net"
      }).toString()
    });

    const defaultsSaved = JSON.parse(await readFile(activeServer.configPaths.defaults, "utf8"));
    const localSaved = JSON.parse(await readFile(activeServer.configPaths.local, "utf8"));
    const usersSaved = JSON.parse(await readFile(activeServer.configPaths.users, "utf8"));

    expect(defaultsSaved.server.smtp.hostname).toBe("mail.test.local");
    expect(localSaved.hostname).toBe("mail.changed.test");
    expect(localSaved.server.imap.port).toBe(3143);
    expect(localSaved.admin.enableTls).toBe(true);
    expect(localSaved.domains).toEqual(["example.test", "example.net"]);
    expect(usersSaved.some((user) => user.username === "bob")).toBe(true);
    expect(usersSaved.find((user) => user.username === "bob")).toEqual({
      username: "bob",
      mailbox: "shared",
      passwordHash: expect.any(String),
      addresses: ["bob@example.test", "sales@example.net"]
    });
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

    const localSaved = JSON.parse(await readFile(activeServer.configPaths.local, "utf8"));
    expect(localSaved.admin.password).toBe("");
    expect(localSaved.admin.passwordHash).toBeTruthy();
    expect(await Bun.password.verify("adminpw", localSaved.admin.passwordHash)).toBe(true);
  });

  test("uses admin.password as an override and replaces an older admin hash after login", async () => {
    activeServer = await setupAdminServer();

    const original = JSON.parse(await readFile(activeServer.configPaths.local, "utf8"));
    original.admin = original.admin ?? {};
    original.admin.password = "newadminpw";
    await writeFile(activeServer.configPaths.local, JSON.stringify(original, null, 2), "utf8");

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

    const localSaved = JSON.parse(await readFile(activeServer.configPaths.local, "utf8"));
    expect(localSaved.admin.password).toBeUndefined();
    expect(await Bun.password.verify("newadminpw", localSaved.admin.passwordHash)).toBe(true);
    expect(await Bun.password.verify("adminpw", localSaved.admin.passwordHash)).toBe(false);
  });

  test("public newsletter subscribe confirms by email and updates users config", async () => {
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

    await fetch(`http://127.0.0.1:${activeServer.adminPort}/users/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie
      },
      redirect: "manual",
      body: new URLSearchParams({
        originalUsername: "alice",
        username: "alice",
        mailbox: "alice",
        addresses: "alice@example.test\nnews@example.test",
        newsletterEnabled: "on",
        newsletterAddress: "news@example.test",
        newsletterTitle: "News",
        newsletterPublicSubscription: "on",
        newsletterPublicUnsubscribe: "on"
      }).toString()
    });

    const page = await fetch(`http://127.0.0.1:${activeServer.adminPort}/lists/alice/subscribe`);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Subscribe to:");
    expect(pageHtml).toContain("News");

    const subscribe = await fetch(`http://127.0.0.1:${activeServer.adminPort}/lists/alice/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ email: "alice@example.test" }).toString()
    });
    expect(subscribe.status).toBe(200);

    let usersSaved = JSON.parse(await readFile(activeServer.configPaths.users, "utf8"));
    expect(usersSaved[0].newsletter.pendingSubscriptions).toHaveLength(1);
    expect(usersSaved[0].newsletter.pendingSubscriptions[0].email).toBe("alice@example.test");

    const rawMessages = [];
    const curGlob = new Bun.Glob("*.eml");
    for await (const file of curGlob.scan({
      cwd: join(activeServer.server.config.storage.rootDir, "mailboxes", "alice", "cur"),
      absolute: true
    })) {
      rawMessages.push(await readFile(file, "utf8"));
    }
    const confirmationMessage = rawMessages.find((message) => message.includes("/lists/alice/confirm?"));
    expect(confirmationMessage).toBeTruthy();
    const confirmUrl = confirmationMessage.match(/http:\/\/127\.0\.0\.1:\d+\/lists\/alice\/confirm\?[^\s]+/)?.[0];
    expect(confirmUrl).toBeTruthy();

    const confirm = await fetch(confirmUrl);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("confirmed");

    usersSaved = JSON.parse(await readFile(activeServer.configPaths.users, "utf8"));
    expect(usersSaved[0].newsletter.pendingSubscriptions).toHaveLength(0);
    expect(usersSaved[0].newsletter.subscribers).toHaveLength(1);
    expect(usersSaved[0].newsletter.subscribers[0].email).toBe("alice@example.test");
  });
});
