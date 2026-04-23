import net from "node:net";
import tls from "node:tls";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { loadConfig } from "../src/config.js";
import { PostOfficeServer } from "../src/server.js";
import { MailboxStore } from "../src/storage.js";

const socketReaders = new WeakMap();

function getSocketReader(socket) {
  let reader = socketReaders.get(socket);
  if (reader) {
    return reader;
  }

  reader = {
    buffer: "",
    waiters: [],
    error: null,
    ended: false
  };

  const settle = () => {
    if (reader.error) {
      const error = reader.error;
      const waiters = reader.waiters.splice(0);
      waiters.forEach(({ reject }) => reject(error));
      return;
    }

    for (let index = 0; index < reader.waiters.length; ) {
      const waiter = reader.waiters[index];
      if (waiter.predicate(reader.buffer)) {
        reader.waiters.splice(index, 1);
        const result = reader.buffer;
        reader.buffer = "";
        waiter.resolve(result);
        continue;
      }
      index += 1;
    }

    if (reader.ended && reader.waiters.length > 0) {
      const error = new Error("Socket ended before predicate matched");
      const waiters = reader.waiters.splice(0);
      waiters.forEach(({ reject }) => reject(error));
    }
  };

  socket.on("data", (chunk) => {
    reader.buffer += chunk.toString("utf8");
    settle();
  });

  socket.on("error", (error) => {
    reader.error = error;
    settle();
  });

  socket.on("end", () => {
    reader.ended = true;
    settle();
  });

  socketReaders.set(socket, reader);
  return reader;
}

export async function createPasswordHash(password) {
  return await Bun.password.hash(password);
}

export async function reservePort() {
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

export async function setupServer() {
  const rootDir = await mkdtemp(join(tmpdir(), "postofficex-"));
  const configDir = join(rootDir, "data");
  await mkdir(configDir, { recursive: true });
  const passwordHash = await createPasswordHash("secret123");
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
        enableTls: true
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
    domains: ["example.test"],
    users: [
      {
        username: "alice",
        mailbox: "alice",
        passwordHash,
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
    JSON.stringify(
      {
        hostname: config.server.smtp.hostname,
        domains: config.domains
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(join(configDir, "users.json"), JSON.stringify(config.users, null, 2), "utf8");
  const resolved = await loadConfig(configPath);
  const server = new PostOfficeServer(resolved, new MailboxStore(resolved));
  await server.start();
  return {
    server,
    configPath,
    rootDir,
    storageRootDir: resolved.storage.rootDir,
    smtpPort,
    submissionPort,
    submissionTlsPort,
    pop3Port,
    pop3TlsPort,
    imapPort,
    imapTlsPort
  };
}

export function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

export function connectTls(port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function readUntil(socket, predicate) {
  const reader = getSocketReader(socket);
  return await new Promise((resolve, reject) => {
    if (reader.error) {
      reject(reader.error);
      return;
    }
    if (predicate(reader.buffer)) {
      const result = reader.buffer;
      reader.buffer = "";
      resolve(result);
      return;
    }
    if (reader.ended) {
      reject(new Error("Socket ended before predicate matched"));
      return;
    }
    reader.waiters.push({ predicate, resolve, reject });
  });
}

export async function pop3Command(socket, command, multiline = false) {
  socket.write(command);
  if (!multiline) {
    return await readUntil(socket, (text) => text.endsWith("\r\n"));
  }
  return await readUntil(socket, (text) => text.endsWith("\r\n.\r\n"));
}

export async function imapCommand(socket, command, predicate = (text) => text.endsWith("\r\n")) {
  socket.write(command);
  return await readUntil(socket, predicate);
}

export function expectOk(response) {
  expect(
    response.startsWith("+OK") ||
      response.startsWith("250") ||
      response.startsWith("220") ||
      response.startsWith("354")
  ).toBe(true);
}
