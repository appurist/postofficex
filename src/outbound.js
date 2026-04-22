import { createReadStream } from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import tls from "node:tls";
import { ensureTrailingCrlf } from "./util.js";

function dotStuff(rawMessage) {
  return ensureTrailingCrlf(rawMessage).replace(/(^|\r?\n)\./g, "$1..");
}

class DotStuffTransform extends Transform {
  constructor() {
    super();
    this.decoder = new StringDecoder("utf8");
    this.atLineStart = true;
  }

  _transform(chunk, encoding, callback) {
    try {
      const text = this.decoder.write(chunk);
      callback(null, this.dotStuffChunk(text));
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      const text = this.decoder.end();
      callback(null, this.dotStuffChunk(text));
    } catch (error) {
      callback(error);
    }
  }

  dotStuffChunk(text) {
    if (!text) {
      return "";
    }

    let output = "";
    for (const char of text) {
      if (this.atLineStart && char === ".") {
        output += ".";
      }
      output += char;
      this.atLineStart = char === "\n";
    }
    return output;
  }
}

class SmtpSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.flush();
    });
  }

  flush() {
    while (this.waiters.length > 0) {
      const line = this.nextLine();
      if (line === null) {
        break;
      }
      this.waiters.shift()(line);
    }
  }

  nextLine() {
    const idx = this.buffer.indexOf("\n");
    if (idx === -1) {
      return null;
    }

    const line = this.buffer.slice(0, idx).replace(/\r$/, "");
    this.buffer = this.buffer.slice(idx + 1);
    return line;
  }

  async readLine() {
    const line = this.nextLine();
    if (line !== null) {
      return line;
    }

    return await new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async readResponse() {
    const lines = [];

    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        return {
          code: Number(line.slice(0, 3)),
          lines,
          message: lines.map((entry) => entry.slice(4)).join("\n")
        };
      }
    }
  }

  writeLine(line) {
    this.socket.write(`${line}\r\n`);
  }

  writeRaw(data) {
    this.socket.write(data);
  }

  async close() {
    if (this.socket.destroyed) {
      return;
    }

    await new Promise((resolve) => {
      this.socket.end(resolve);
    });
  }
}

function groupRecipientsByDomain(recipients) {
  const grouped = new Map();

  for (const recipient of recipients) {
    const [, domain] = recipient.split("@");
    if (!domain) {
      continue;
    }
    const key = domain.toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(recipient);
  }

  return grouped;
}

export class OutboundSmtpRelay {
  constructor(config, log, deps = {}) {
    this.config = config;
    this.log = log;
    this.resolveMx = deps.resolveMx ?? dns.resolveMx;
  }

  updateConfig(config) {
    this.config = config;
  }

  async connect(host, port) {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(this.config.outbound.connectTimeoutMs, () => {
        socket.destroy(new Error(`Outbound SMTP timeout to ${host}:${port}`));
      });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
    });
  }

  async resolveMxTargets(domain) {
    try {
      const records = await this.resolveMx(domain);
      if (!records.length) {
        return [{ exchange: domain, port: 25 }];
      }

      return [...records]
        .sort((a, b) => a.priority - b.priority)
        .map((record) => ({
          exchange: record.exchange,
          port: record.port ?? 25
        }));
    } catch {
      return [{ exchange: domain, port: 25 }];
    }
  }

  async expectCode(client, acceptedCodes) {
    const response = await client.readResponse();
    if (!acceptedCodes.includes(response.code)) {
      throw new Error(`Remote SMTP rejected command with ${response.code}: ${response.message}`);
    }
    return response;
  }

  async runCommand(client, command, acceptedCodes) {
    client.writeLine(command);
    return await this.expectCode(client, acceptedCodes);
  }

  async upgradeToTls(socket, host) {
    return await new Promise((resolve, reject) => {
      const secured = tls.connect(
        {
          socket,
          servername: host
        },
        () => resolve(secured)
      );
      secured.once("error", reject);
    });
  }

  async deliverToTarget(target, mailFrom, recipients, rawMessage) {
    let socket = await this.connect(target.exchange, target.port);
    let client = new SmtpSocketClient(socket);

    try {
      await this.expectCode(client, [220]);
      let ehlo = await this.runCommand(client, `EHLO ${this.config.outbound.greetingHostname}`, [250]);

      const supportsStartTls = ehlo.lines.some((line) => /STARTTLS/i.test(line));
      if (this.config.outbound.preferStartTls && supportsStartTls) {
        await this.runCommand(client, "STARTTLS", [220]);
        socket = await this.upgradeToTls(socket, target.exchange);
        client = new SmtpSocketClient(socket);
        await this.runCommand(client, `EHLO ${this.config.outbound.greetingHostname}`, [250]);
      }

      await this.runCommand(client, `MAIL FROM:<${mailFrom}>`, [250]);
      for (const recipient of recipients) {
        await this.runCommand(client, `RCPT TO:<${recipient}>`, [250, 251]);
      }

      await this.runCommand(client, "DATA", [354]);
      client.writeRaw(`${dotStuff(rawMessage)}.\r\n`);
      await this.expectCode(client, [250]);
      await this.runCommand(client, "QUIT", [221]);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async deliverFileToTarget(target, mailFrom, recipients, filePath) {
    let socket = await this.connect(target.exchange, target.port);
    let client = new SmtpSocketClient(socket);

    try {
      await this.expectCode(client, [220]);
      let ehlo = await this.runCommand(client, `EHLO ${this.config.outbound.greetingHostname}`, [250]);

      const supportsStartTls = ehlo.lines.some((line) => /STARTTLS/i.test(line));
      if (this.config.outbound.preferStartTls && supportsStartTls) {
        await this.runCommand(client, "STARTTLS", [220]);
        socket = await this.upgradeToTls(socket, target.exchange);
        client = new SmtpSocketClient(socket);
        await this.runCommand(client, `EHLO ${this.config.outbound.greetingHostname}`, [250]);
      }

      await this.runCommand(client, `MAIL FROM:<${mailFrom}>`, [250]);
      for (const recipient of recipients) {
        await this.runCommand(client, `RCPT TO:<${recipient}>`, [250, 251]);
      }

      await this.runCommand(client, "DATA", [354]);
      await pipeline(createReadStream(filePath), new DotStuffTransform(), socket, { end: false });
      client.writeRaw(".\r\n");
      await this.expectCode(client, [250]);
      await this.runCommand(client, "QUIT", [221]);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async deliver({ mailFrom, rcptTo, rawMessage }) {
    const grouped = groupRecipientsByDomain(rcptTo);

    for (const [domain, recipients] of grouped) {
      const targets = await this.resolveMxTargets(domain);
      let lastError = null;

      for (const target of targets) {
        try {
          await this.deliverToTarget(target, mailFrom, recipients, rawMessage);
          this.log.info("smtp.outbound_delivered", {
            domain,
            targetHost: target.exchange,
            targetPort: target.port,
            recipients
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          this.log.warn("smtp.outbound_target_failed", {
            domain,
            targetHost: target.exchange,
            targetPort: target.port,
            error: `${error}`
          });
        }
      }

      if (lastError) {
        throw lastError;
      }
    }
  }

  async deliverFromFile({ mailFrom, rcptTo, filePath }) {
    const grouped = groupRecipientsByDomain(rcptTo);

    for (const [domain, recipients] of grouped) {
      const targets = await this.resolveMxTargets(domain);
      let lastError = null;

      for (const target of targets) {
        try {
          await this.deliverFileToTarget(target, mailFrom, recipients, filePath);
          this.log.info("smtp.outbound_delivered", {
            domain,
            targetHost: target.exchange,
            targetPort: target.port,
            recipients
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          this.log.warn("smtp.outbound_target_failed", {
            domain,
            targetHost: target.exchange,
            targetPort: target.port,
            error: `${error}`
          });
        }
      }

      if (lastError) {
        throw lastError;
      }
    }
  }
}
