import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
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

async function setupSubmissionServer({ resolveMx } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "postofficex-submission-"));
  const userPasswordHash = await createPasswordHash("secret123");
  const smtpPort = await reservePort();
  const submissionPort = await reservePort();
  const submissionTlsPort = await reservePort();
  const pop3Port = await reservePort();
  const pop3TlsPort = await reservePort();
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
  const server = new PostOfficeServer(resolved, new MailboxStore(resolved), undefined, {
    outbound: resolveMx ? { resolveMx } : undefined
  });
  await server.start();
  return { server, submissionPort, pop3Port };
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
});
