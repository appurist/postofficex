import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { PostOfficeServer } from "../src/server.js";
import { MailboxStore } from "../src/storage.js";
import { connect, createPasswordHash, pop3Command, readUntil, reservePort } from "./helpers.js";

let active = null;
let remoteServer = null;

function createRemoteSmtpServer() {
  const deliveries = [];

  const server = net.createServer((socket) => {
    let buffer = "";
    let dataMode = false;
    let dataLines = [];
    let mailFrom = "";
    let recipients = [];

    socket.write("220 remote.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) {
          break;
        }

        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);

        if (dataMode) {
          if (line === ".") {
            deliveries.push({
              mailFrom,
              recipients: [...recipients],
              rawMessage: `${dataLines.join("\r\n")}\r\n`
            });
            dataMode = false;
            dataLines = [];
            socket.write("250 2.0.0 accepted\r\n");
            continue;
          }

          dataLines.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }

        if (/^EHLO /i.test(line) || /^HELO /i.test(line)) {
          socket.write("250-remote.test\r\n250 SIZE 10485760\r\n");
          continue;
        }

        if (/^MAIL FROM:/i.test(line)) {
          mailFrom = line.replace(/^MAIL FROM:\s*/i, "");
          recipients = [];
          socket.write("250 2.1.0 sender ok\r\n");
          continue;
        }

        if (/^RCPT TO:/i.test(line)) {
          recipients.push(line.replace(/^RCPT TO:\s*/i, ""));
          socket.write("250 2.1.5 recipient ok\r\n");
          continue;
        }

        if (/^DATA$/i.test(line)) {
          dataMode = true;
          dataLines = [];
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          continue;
        }

        if (/^QUIT$/i.test(line)) {
          socket.write("221 2.0.0 bye\r\n");
          socket.end();
          continue;
        }

        socket.write("502 5.5.2 command not implemented\r\n");
      }
    });
  });

  return { server, deliveries };
}

async function setupSubmissionServer({ resolveMx, users } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "postofficex-submission-"));
  const configDir = join(rootDir, "data");
  await mkdir(configDir, { recursive: true });
  const userPasswordHash = await createPasswordHash("secret123");
  const smtpPort = await reservePort();
  const submissionPort = await reservePort();
  const submissionTlsPort = await reservePort();
  const pop3Port = await reservePort();
  const pop3TlsPort = await reservePort();
  const imapPort = await reservePort();
  const imapTlsPort = await reservePort();
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
      certFile: "./missing.crt",
      keyFile: "./missing.key"
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
    domains: ["example.test"],
    users: users ?? [
      {
        username: "alice",
        mailbox: "alice",
        passwordHash: userPasswordHash,
        addresses: ["alice@example.test"]
      }
    ]
  };

  const configPath = join(configDir, "local.json");
  await writeFile(
    join(configDir, "defaults.json"),
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
    configPath,
    JSON.stringify({ hostname: config.server.smtp.hostname, domains: config.domains }, null, 2),
    "utf8"
  );
  await writeFile(join(configDir, "users.json"), JSON.stringify(config.users, null, 2), "utf8");
  const resolved = await loadConfig(configPath);
  const server = new PostOfficeServer(resolved, new MailboxStore(resolved), undefined, {
    outbound: resolveMx ? { resolveMx } : undefined
  });
  await server.start();
  return { server, submissionPort, pop3Port, storageRootDir: resolved.storage.rootDir };
}

async function smtpCommand(socket, command, multiline = false) {
  socket.write(command);
  if (!multiline) {
    return await readUntil(socket, (text) => text.endsWith("\r\n"));
  }

  return await readUntil(socket, (text) => text.endsWith("\r\n.\r\n"));
}

afterEach(async () => {
  if (active) {
    await active.server.stop();
    active = null;
  }

  if (remoteServer) {
    await new Promise((resolve, reject) => {
      remoteServer.server.close((error) => (error ? reject(error) : resolve()));
    });
    remoteServer = null;
  }
});

describe("smtp submission", () => {
  test("requires authentication before accepting a submitted sender", async () => {
    active = await setupSubmissionServer();

    const smtp = await connect(active.submissionPort);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    smtp.write("EHLO localhost\r\n");
    const ehlo = await readUntil(smtp, (text) => text.includes("250 SIZE"));
    expect(ehlo).toContain("250-AUTH PLAIN LOGIN");

    smtp.write("MAIL FROM:<alice@example.test>\r\n");
    const response = await readUntil(smtp, (text) => text.endsWith("\r\n"));
    expect(response).toContain("530 5.7.0");
    smtp.end();
  });

  test("stores local-only submitted mail in the local mailbox", async () => {
    active = await setupSubmissionServer();

    const smtp = await connect(active.submissionPort);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtp, "EHLO localhost\r\n");
    const auth = Buffer.from("\u0000alice\u0000secret123").toString("base64");
    expect(await smtpCommand(smtp, `AUTH PLAIN ${auth}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtp, "MAIL FROM:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "DATA\r\n")).toContain("354");
    expect(
      await smtpCommand(
        smtp,
        "From: alice@example.test\r\nTo: alice@example.test\r\nSubject: local submit\r\n\r\nlocal body\r\n.\r\n"
      )
    ).toContain("250");
    expect(await smtpCommand(smtp, "QUIT\r\n")).toContain("221");

    const pop3 = await connect(active.pop3Port);
    await readUntil(pop3, (text) => text.endsWith("\r\n"));
    expect(await pop3Command(pop3, "USER alice\r\n")).toContain("+OK");
    expect(await pop3Command(pop3, "PASS secret123\r\n")).toContain("+OK");
    const message = await pop3Command(pop3, "RETR 1\r\n", true);
    expect(message).toContain("Subject: local submit");
    expect(message).toContain("local body");
    pop3.end();
  });

  test("delivers submitted external mail over outbound smtp", async () => {
    remoteServer = createRemoteSmtpServer();
    const remotePort = await reservePort();
    await new Promise((resolve, reject) => {
      remoteServer.server.once("error", reject);
      remoteServer.server.listen(remotePort, "127.0.0.1", resolve);
    });

    active = await setupSubmissionServer({
      resolveMx: async (domain) => [{ exchange: "127.0.0.1", port: remotePort, priority: domain === "remote.test" ? 0 : 10 }]
    });

    const smtp = await connect(active.submissionPort);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtp, "EHLO localhost\r\n");
    expect(await smtpCommand(smtp, "AUTH LOGIN\r\n")).toContain("334");
    expect(await smtpCommand(smtp, `${Buffer.from("alice").toString("base64")}\r\n`)).toContain("334");
    expect(await smtpCommand(smtp, `${Buffer.from("secret123").toString("base64")}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtp, "MAIL FROM:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<bob@remote.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "DATA\r\n")).toContain("354");
    expect(
      await smtpCommand(
        smtp,
        "From: alice@example.test\r\nTo: bob@remote.test\r\nSubject: outbound submit\r\n\r\nremote body\r\n.\r\n"
      )
    ).toContain("250");
    expect(await smtpCommand(smtp, "QUIT\r\n")).toContain("221");

    expect(remoteServer.deliveries).toHaveLength(1);
    expect(remoteServer.deliveries[0].mailFrom).toBe("<alice@example.test>");
    expect(remoteServer.deliveries[0].recipients).toEqual(["<bob@remote.test>"]);
    expect(remoteServer.deliveries[0].rawMessage).toContain("Subject: outbound submit");
    expect(remoteServer.deliveries[0].rawMessage).toContain("remote body");
  });

  test("accepts submission auth by email address and repeated-domain login", async () => {
    active = await setupSubmissionServer();

    const smtpA = await connect(active.submissionPort);
    await readUntil(smtpA, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtpA, "EHLO localhost\r\n");
    const authA = Buffer.from("\u0000alice@example.test\u0000secret123").toString("base64");
    expect(await smtpCommand(smtpA, `AUTH PLAIN ${authA}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtpA, "MAIL FROM:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtpA, "QUIT\r\n")).toContain("221");

    const smtpB = await connect(active.submissionPort);
    await readUntil(smtpB, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtpB, "EHLO localhost\r\n");
    const authB = Buffer.from("\u0000alice@example.test@example.test\u0000secret123").toString("base64");
    expect(await smtpCommand(smtpB, `AUTH PLAIN ${authB}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtpB, "MAIL FROM:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtpB, "QUIT\r\n")).toContain("221");
  });

  test("accepts MAIL FROM with ESMTP SIZE parameter", async () => {
    active = await setupSubmissionServer();

    const smtp = await connect(active.submissionPort);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtp, "EHLO localhost\r\n");
    const auth = Buffer.from("\u0000alice@example.test\u0000secret123").toString("base64");
    expect(await smtpCommand(smtp, `AUTH PLAIN ${auth}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtp, "MAIL FROM:<alice@example.test> SIZE=1701\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "QUIT\r\n")).toContain("221");
  });

  test("stores local recipients while also relaying external recipients", async () => {
    remoteServer = createRemoteSmtpServer();
    const remotePort = await reservePort();
    await new Promise((resolve, reject) => {
      remoteServer.server.once("error", reject);
      remoteServer.server.listen(remotePort, "127.0.0.1", resolve);
    });

    active = await setupSubmissionServer({
      resolveMx: async (domain) => [{ exchange: "127.0.0.1", port: remotePort, priority: 0 }]
    });

    const smtp = await connect(active.submissionPort);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtp, "EHLO localhost\r\n");
    const auth = Buffer.from("\u0000alice@example.test\u0000secret123").toString("base64");
    expect(await smtpCommand(smtp, `AUTH PLAIN ${auth}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtp, "MAIL FROM:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<bob@remote.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "DATA\r\n")).toContain("354");
    expect(
      await smtpCommand(
        smtp,
        "From: alice@example.test\r\nTo: alice@example.test, bob@remote.test\r\nSubject: mixed submit\r\n\r\nmixed body\r\n.\r\n"
      )
    ).toContain("250");
    expect(await smtpCommand(smtp, "QUIT\r\n")).toContain("221");

    const pop3 = await connect(active.pop3Port);
    await readUntil(pop3, (text) => text.endsWith("\r\n"));
    expect(await pop3Command(pop3, "USER alice\r\n")).toContain("+OK");
    expect(await pop3Command(pop3, "PASS secret123\r\n")).toContain("+OK");
    const message = await pop3Command(pop3, "RETR 1\r\n", true);
    expect(message).toContain("Subject: mixed submit");
    expect(message).toContain("mixed body");
    expect(await pop3Command(pop3, "QUIT\r\n")).toContain("+OK");

    expect(remoteServer.deliveries).toHaveLength(1);
    expect(remoteServer.deliveries[0].recipients).toEqual(["<bob@remote.test>"]);
    expect(remoteServer.deliveries[0].rawMessage).toContain("Subject: mixed submit");
  });

  test("handles chunked large mixed-recipient submissions without overlapping socket reads", async () => {
    remoteServer = createRemoteSmtpServer();
    const remotePort = await reservePort();
    await new Promise((resolve, reject) => {
      remoteServer.server.once("error", reject);
      remoteServer.server.listen(remotePort, "127.0.0.1", resolve);
    });

    active = await setupSubmissionServer({
      resolveMx: async () => [{ exchange: "127.0.0.1", port: remotePort, priority: 0 }]
    });

    const smtp = await connect(active.submissionPort);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtp, "EHLO localhost\r\n");
    const auth = Buffer.from("\u0000alice@example.test\u0000secret123").toString("base64");
    expect(await smtpCommand(smtp, `AUTH PLAIN ${auth}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtp, "MAIL FROM:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<bob@remote.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "DATA\r\n")).toContain("354");

    const body = [
      "From: alice@example.test\r\n",
      "To: alice@example.test, bob@remote.test\r\n",
      "Subject: chunked large mixed submit\r\n",
      "\r\n",
      ...Array.from({ length: 2048 }, (_, index) => `line ${index} ${"x".repeat(180)}\r\n`),
      ".\r\n"
    ].join("");

    for (let index = 0; index < body.length; index += 257) {
      smtp.write(body.slice(index, index + 257));
      await Bun.sleep(0);
    }

    const dataResult = await readUntil(smtp, (text) => text.endsWith("\r\n"));
    expect(dataResult).toContain("250");
    expect(await smtpCommand(smtp, "QUIT\r\n")).toContain("221");

    const pop3 = await connect(active.pop3Port);
    await readUntil(pop3, (text) => text.endsWith("\r\n"));
    expect(await pop3Command(pop3, "USER alice\r\n")).toContain("+OK");
    expect(await pop3Command(pop3, "PASS secret123\r\n")).toContain("+OK");
    const message = await pop3Command(pop3, "RETR 1\r\n", true);
    expect(message).toContain("Subject: chunked large mixed submit");
    expect(message).toContain("line 2047");
    expect(await pop3Command(pop3, "QUIT\r\n")).toContain("+OK");

    expect(remoteServer.deliveries).toHaveLength(1);
    expect(remoteServer.deliveries[0].rawMessage).toContain("Subject: chunked large mixed submit");
    expect(remoteServer.deliveries[0].rawMessage).toContain("line 2047");
  });

  test("expands owner-submitted newsletter mail to confirmed subscribers", async () => {
    remoteServer = createRemoteSmtpServer();
    const remotePort = await reservePort();
    await new Promise((resolve, reject) => {
      remoteServer.server.once("error", reject);
      remoteServer.server.listen(remotePort, "127.0.0.1", resolve);
    });

    const passwordHash = await createPasswordHash("secret123");
    active = await setupSubmissionServer({
      resolveMx: async () => [{ exchange: "127.0.0.1", port: remotePort, priority: 0 }],
      users: [
        {
          username: "alice",
          mailbox: "alice",
          passwordHash,
          addresses: ["alice@example.test", "news@example.test"],
          newsletter: {
            enabled: true,
            address: "news@example.test",
            title: "News",
            publicSubscription: true,
            publicUnsubscribe: true,
            subscribers: [
              {
                email: "bob@remote.test",
                subscribedAt: new Date().toISOString(),
                unsubscribeTokenHash: "hash"
              }
            ],
            pendingSubscriptions: []
          }
        }
      ]
    });

    const smtp = await connect(active.submissionPort);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtp, "EHLO localhost\r\n");
    const auth = Buffer.from("\u0000alice@example.test\u0000secret123").toString("base64");
    expect(await smtpCommand(smtp, `AUTH PLAIN ${auth}\r\n`)).toContain("235 2.7.0");
    expect(await smtpCommand(smtp, "MAIL FROM:<alice@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<news@example.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "DATA\r\n")).toContain("354");
    expect(
      await smtpCommand(
        smtp,
        "From: alice@example.test\r\nTo: news@example.test\r\nSubject: newsletter\r\n\r\nhello list\r\n.\r\n"
      )
    ).toContain("250");
    expect(await smtpCommand(smtp, "QUIT\r\n")).toContain("221");

    expect(remoteServer.deliveries).toHaveLength(1);
    expect(remoteServer.deliveries[0].recipients).toEqual(["<bob@remote.test>"]);
    expect(remoteServer.deliveries[0].rawMessage).toContain("Subject: newsletter");
    expect(remoteServer.deliveries[0].rawMessage).toContain("List-Id:");
    expect(remoteServer.deliveries[0].rawMessage).toContain("List-Unsubscribe:");
  });

  test("rejects newsletter posts from unauthenticated inbound smtp", async () => {
    const passwordHash = await createPasswordHash("secret123");
    active = await setupSubmissionServer({
      users: [
        {
          username: "alice",
          mailbox: "alice",
          passwordHash,
          addresses: ["alice@example.test", "news@example.test"],
          newsletter: {
            enabled: true,
            address: "news@example.test",
            title: "News",
            publicSubscription: true,
            publicUnsubscribe: true,
            subscribers: [],
            pendingSubscriptions: []
          }
        }
      ]
    });

    const smtp = await connect(active.server.config.server.smtp.port);
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    await smtpCommand(smtp, "EHLO localhost\r\n");
    expect(await smtpCommand(smtp, "MAIL FROM:<sender@remote.test>\r\n")).toContain("250");
    expect(await smtpCommand(smtp, "RCPT TO:<news@example.test>\r\n")).toContain("550 5.7.1");
    smtp.end();
  });
});
