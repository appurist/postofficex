import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { loadConfig } from "../src/config.js";
import { PostOfficeServer } from "../src/server.js";
import { MailboxStore } from "../src/storage.js";

export async function createPasswordHash(password) {
  return await Bun.password.hash(password);
}

export async function setupServer() {
  const rootDir = await mkdtemp(join(tmpdir(), "postofficex-"));
  const passwordHash = await createPasswordHash("secret123");
  const config = {
    server: {
      smtp: {
        host: "127.0.0.1",
        port: 2526,
        hostname: "mail.test.local",
        allowPlaintext: true,
        enableStartTls: false
      },
      pop3: {
        host: "127.0.0.1",
        port: 2111,
        tlsPort: 2996,
        allowPlaintext: true,
        enableTls: false
      }
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
        passwordHash,
        addresses: ["alice@example.test"]
      }
    ]
  };

  const configPath = join(rootDir, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const resolved = await loadConfig(configPath);
  const server = new PostOfficeServer(resolved, new MailboxStore(resolved));
  await server.start();
  return { server, configPath, rootDir };
}

export function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function readUntil(socket, predicate) {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (predicate(buffer)) {
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(buffer);
      }
    };
    const onError = (error) => {
      socket.off("data", onData);
      socket.off("error", onError);
      reject(error);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

export async function pop3Command(socket, command, multiline = false) {
  socket.write(command);
  if (!multiline) {
    return await readUntil(socket, (text) => text.endsWith("\r\n"));
  }
  return await readUntil(socket, (text) => text.endsWith("\r\n.\r\n"));
}

export function expectOk(response) {
  expect(
    response.startsWith("+OK") ||
      response.startsWith("250") ||
      response.startsWith("220") ||
      response.startsWith("354")
  ).toBe(true);
}
