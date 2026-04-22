import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { AdminUiServer } from "./admin.js";
import { buildUserDirectory } from "./config.js";
import { verifyPassword } from "./auth.js";
import { logger } from "./logger.js";
import { ensureTrailingCrlf, stripSmtpPath } from "./util.js";

export class PostOfficeServer {
  constructor(config, store, log = logger) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.users = buildUserDirectory(config);
    this.smtpServer = undefined;
    this.pop3Server = undefined;
    this.pop3TlsServer = undefined;
    this.adminServer = undefined;
    this.tlsMaterial = undefined;
  }

  async start() {
    await this.store.initialize();
    await this.store.recoverAll();

    if (this.config.server.smtp.enableStartTls || this.config.server.pop3.enableTls || this.config.admin?.enableTls) {
      this.tlsMaterial = {
        cert: await readFile(this.config.tls.certFile, "utf8"),
        key: await readFile(this.config.tls.keyFile, "utf8")
      };
    }

    this.smtpServer = net.createServer((socket) => this.handleSmtp(socket, false));
    this.pop3Server = net.createServer((socket) => this.handlePop3(socket, false, false));

    await Promise.all([
      this.listen(this.smtpServer, this.config.server.smtp.port, this.config.server.smtp.host),
      this.listen(this.pop3Server, this.config.server.pop3.port, this.config.server.pop3.host)
    ]);

    if (this.config.server.pop3.enableTls) {
      if (!this.tlsMaterial) {
        throw new Error("POP3 TLS is enabled but TLS material is unavailable");
      }

      this.pop3TlsServer = tls.createServer(
        {
          cert: this.tlsMaterial.cert,
          key: this.tlsMaterial.key
        },
        (socket) => this.handlePop3(socket, true, true)
      );

      await this.listen(this.pop3TlsServer, this.config.server.pop3.tlsPort, this.config.server.pop3.host);
    }

    this.adminServer = new AdminUiServer(
      this.config,
      (nextConfig) => this.applyConfig(nextConfig),
      this.log,
      this.tlsMaterial
    );
    await this.adminServer.start();

    this.log.info("server.started", {
      smtpPort: this.config.server.smtp.port,
      pop3Port: this.config.server.pop3.port,
      pop3TlsPort: this.config.server.pop3.enableTls ? this.config.server.pop3.tlsPort : null,
      adminPort: this.adminServer.enabled ? this.config.admin.port : null
    });
  }

  async stop() {
    await Promise.all([
      this.closeServer(this.smtpServer),
      this.closeServer(this.pop3Server),
      this.closeServer(this.pop3TlsServer),
      this.adminServer?.stop()
    ]);
  }

  applyConfig(nextConfig) {
    this.config = nextConfig;
    this.store.config = nextConfig;
    this.users = buildUserDirectory(nextConfig);
    this.adminServer?.updateConfig(nextConfig);
  }

  async listen(server, port, host) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("error", onError);
        const wrapped = new Error(`Failed to listen on ${host}:${port}: ${error.message}`);
        wrapped.code = error.code;
        wrapped.cause = error;
        reject(wrapped);
      };

      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  async closeServer(server) {
    if (!server) {
      return;
    }

    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  wrapSocketForStartTls(socket) {
    if (!this.tlsMaterial) {
      throw new Error("TLS material not loaded");
    }

    return new tls.TLSSocket(socket, {
      isServer: true,
      cert: this.tlsMaterial.cert,
      key: this.tlsMaterial.key
    });
  }

  attachCommonSocketState(socket) {
    socket.setTimeout(this.config.limits.socketTimeoutMs, () => {
      socket.write("-ERR inactivity timeout\r\n");
      socket.end();
    });
  }

  handleSmtp(rawSocket, secure, sendGreeting = true) {
    let socket = rawSocket;
    const state = {
      secure,
      helo: null,
      mailFrom: null,
      rcptTo: [],
      dataMode: false,
      dataLines: [],
      closed: false
    };

    const resetMessage = () => {
      state.mailFrom = null;
      state.rcptTo = [];
      state.dataMode = false;
      state.dataLines = [];
    };

    const write = (message) => {
      if (!state.closed) {
        socket.write(message);
      }
    };

    const resetListenersForStartTls = () => {
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
    };

    const processLine = async (line) => {
      if (state.dataMode) {
        if (line === ".") {
          const rawMessage = `${state.dataLines.join("\r\n")}\r\n`;
          state.dataMode = false;
          state.dataLines = [];

          try {
            await this.persistSmtpMessage(state, rawMessage, socket);
            write("250 2.0.0 message accepted\r\n");
          } catch (error) {
            this.log.error("smtp.delivery_failed", { error: `${error}` });
            write(`552 5.3.4 ${String(error instanceof Error ? error.message : error)}\r\n`);
          } finally {
            resetMessage();
          }
          return;
        }

        const unescaped = line.startsWith("..") ? line.slice(1) : line;
        state.dataLines.push(unescaped);
        const bytes = Buffer.byteLength(state.dataLines.join("\r\n"), "utf8");
        if (bytes > this.config.limits.maxMessageBytes) {
          resetMessage();
          write("552 5.3.4 message too large\r\n");
        }
        return;
      }

      const [verb, ...rest] = line.split(" ");
      const command = (verb ?? "").toUpperCase();
      const argument = rest.join(" ").trim();

      switch (command) {
        case "EHLO":
        case "HELO":
          state.helo = argument || "unknown";
          resetMessage();
          if (command === "EHLO") {
            const lines = [`250-${this.config.server.smtp.hostname}`];
            if (this.config.server.smtp.enableStartTls && !state.secure) {
              lines.push("250-STARTTLS");
            }
            lines.push(`250 SIZE ${this.config.limits.maxMessageBytes}`);
            write(`${lines.join("\r\n")}\r\n`);
          } else {
            write(`250 ${this.config.server.smtp.hostname}\r\n`);
          }
          return;
        case "STARTTLS":
          if (!this.config.server.smtp.enableStartTls) {
            write("454 4.7.0 TLS not available\r\n");
            return;
          }
          if (state.secure) {
            write("454 4.7.0 TLS already active\r\n");
            return;
          }
          write("220 2.0.0 Ready to start TLS\r\n");
          resetListenersForStartTls();
          socket = this.wrapSocketForStartTls(socket);
          state.secure = true;
          this.handleSmtp(socket, true, false);
          return;
        case "MAIL":
          if (!state.helo) {
            write("503 5.5.1 send HELO/EHLO first\r\n");
            return;
          }
          if (!/^FROM:/i.test(argument)) {
            write("501 5.5.4 malformed MAIL FROM\r\n");
            return;
          }
          resetMessage();
          state.mailFrom = stripSmtpPath(argument.slice(5).trim());
          write("250 2.1.0 sender ok\r\n");
          return;
        case "RCPT":
          if (!state.mailFrom) {
            write("503 5.5.1 send MAIL FROM first\r\n");
            return;
          }
          if (!/^TO:/i.test(argument)) {
            write("501 5.5.4 malformed RCPT TO\r\n");
            return;
          }
          if (state.rcptTo.length >= this.config.limits.maxRecipientsPerMessage) {
            write("452 4.5.3 too many recipients\r\n");
            return;
          }
          {
            const address = stripSmtpPath(argument.slice(3).trim());
            const user = this.users.usersByAddress.get(address);
            const [, domain] = address.split("@");
            if (!domain || !this.config.domains.includes(domain) || !user) {
              write("550 5.1.1 recipient rejected\r\n");
              return;
            }
            state.rcptTo.push(address);
            write("250 2.1.5 recipient ok\r\n");
          }
          return;
        case "DATA":
          if (state.rcptTo.length === 0) {
            write("503 5.5.1 need RCPT TO first\r\n");
            return;
          }
          state.dataMode = true;
          state.dataLines = [];
          write("354 End data with <CR><LF>.<CR><LF>\r\n");
          return;
        case "RSET":
          resetMessage();
          write("250 2.0.0 reset state\r\n");
          return;
        case "NOOP":
          write("250 2.0.0 ok\r\n");
          return;
        case "QUIT":
          write("221 2.0.0 bye\r\n");
          state.closed = true;
          socket.end();
          return;
        default:
          write("502 5.5.2 command not implemented\r\n");
      }
    };

    this.attachCommonSocketState(socket);
    if (sendGreeting) {
      write(`220 ${this.config.server.smtp.hostname} ESMTP PostOfficeX\r\n`);
    }

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      void this.consumeLines(buffer, async (line, remaining) => {
        buffer = remaining;
        await processLine(line);
      });
    });

    socket.on("error", (error) => {
      this.log.warn("smtp.socket_error", { error: `${error}` });
    });
    socket.on("close", () => {
      state.closed = true;
    });
  }

  async persistSmtpMessage(state, rawMessage, socket) {
    const delivered = new Set();
    for (const address of state.rcptTo) {
      const user = this.users.usersByAddress.get(address);
      if (!user || delivered.has(user.mailbox)) {
        continue;
      }
      delivered.add(user.mailbox);
      await this.store.deliver(user.mailbox, {
        mailFrom: state.mailFrom,
        rcptTo: state.rcptTo,
        rawMessage: ensureTrailingCrlf(rawMessage),
        remoteAddress: socket.remoteAddress ?? null
      });
    }

    this.log.info("smtp.message_stored", {
      recipients: state.rcptTo,
      secure: state.secure,
      remoteAddress: socket.remoteAddress ?? null
    });
  }

  handlePop3(rawSocket, secure, implicitTls, sendGreeting = true) {
    let socket = rawSocket;
    const state = {
      secure,
      username: null,
      mailbox: null,
      authenticated: false,
      deleteMarks: new Set(),
      authFailures: 0
    };

    const write = (message) => {
      socket.write(message);
    };

    const resetListenersForTls = () => {
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
    };

    const processCommand = async (line) => {
      const [verb, ...rest] = line.split(" ");
      const command = (verb ?? "").toUpperCase();
      const argument = rest.join(" ").trim();

      if (!state.authenticated) {
        switch (command) {
          case "STLS":
            if (implicitTls || state.secure) {
              write("-ERR TLS already active\r\n");
              return;
            }
            if (!this.config.server.pop3.enableTls) {
              write("-ERR TLS unavailable\r\n");
              return;
            }
            write("+OK Begin TLS negotiation\r\n");
            resetListenersForTls();
            socket = this.wrapSocketForStartTls(socket);
            state.secure = true;
            this.handlePop3(socket, true, false, false);
            return;
          case "USER":
            state.username = argument.toLowerCase();
            write("+OK user accepted\r\n");
            return;
          case "PASS":
            if (!state.username) {
              write("-ERR USER required first\r\n");
              return;
            }
            if (!state.secure && !this.config.server.pop3.allowPlaintext) {
              write("-ERR TLS required before authentication\r\n");
              return;
            }
            {
              const user = this.users.usersByUsername.get(state.username);
              const valid = user ? await verifyPassword(argument, user.passwordHash) : false;
              if (!valid || !user) {
                state.authFailures += 1;
                if (state.authFailures >= this.config.limits.maxInvalidAuthAttempts) {
                  write("-ERR too many auth failures\r\n");
                  socket.end();
                  return;
                }
                write("-ERR invalid credentials\r\n");
                return;
              }

              state.authenticated = true;
              state.mailbox = user.mailbox;
              state.deleteMarks.clear();
              write("+OK mailbox locked and ready\r\n");
            }
            return;
          case "QUIT":
            write("+OK bye\r\n");
            socket.end();
            return;
          default:
            write("-ERR authenticate first\r\n");
            return;
        }
      }

      const mailbox = state.mailbox;
      const visibleMessages = async () => {
        const items = await this.store.listMessages(mailbox);
        return items.filter((item) => !state.deleteMarks.has(item.id));
      };

      switch (command) {
        case "STAT": {
          const items = await visibleMessages();
          const total = items.reduce((sum, item) => sum + item.size, 0);
          write(`+OK ${items.length} ${total}\r\n`);
          return;
        }
        case "LIST": {
          const items = await visibleMessages();
          if (!argument) {
            write(`+OK ${items.length} messages\r\n`);
            items.forEach((item, index) => write(`${index + 1} ${item.size}\r\n`));
            write(".\r\n");
            return;
          }
          const index = Number(argument);
          const item = items[index - 1];
          if (!item) {
            write("-ERR no such message\r\n");
            return;
          }
          write(`+OK ${index} ${item.size}\r\n`);
          return;
        }
        case "UIDL": {
          const items = await visibleMessages();
          if (!argument) {
            write("+OK unique-id listing follows\r\n");
            items.forEach((item, index) => write(`${index + 1} ${item.uidl}\r\n`));
            write(".\r\n");
            return;
          }
          const index = Number(argument);
          const item = items[index - 1];
          if (!item) {
            write("-ERR no such message\r\n");
            return;
          }
          write(`+OK ${index} ${item.uidl}\r\n`);
          return;
        }
        case "RETR": {
          const items = await visibleMessages();
          const index = Number(argument);
          const item = items[index - 1];
          if (!item) {
            write("-ERR no such message\r\n");
            return;
          }
          const raw = await this.store.getMessage(mailbox, item.id);
          write(`+OK ${item.size} octets\r\n`);
          const dotStuffed = raw.replace(/\r?\n\./g, "\r\n..");
          write(ensureTrailingCrlf(dotStuffed));
          write(".\r\n");
          return;
        }
        case "DELE": {
          const items = await visibleMessages();
          const index = Number(argument);
          const item = items[index - 1];
          if (!item) {
            write("-ERR no such message\r\n");
            return;
          }
          state.deleteMarks.add(item.id);
          write(`+OK message ${index} deleted\r\n`);
          return;
        }
        case "RSET":
          state.deleteMarks.clear();
          write("+OK reset state\r\n");
          return;
        case "NOOP":
          write("+OK\r\n");
          return;
        case "QUIT":
          for (const id of state.deleteMarks) {
            await this.store.deleteMessage(mailbox, id);
          }
          write("+OK bye\r\n");
          socket.end();
          return;
        default:
          write("-ERR command not supported\r\n");
      }
    };

    this.attachCommonSocketState(socket);
    if (sendGreeting) {
      write(`+OK ${this.config.server.smtp.hostname} POP3 ready\r\n`);
    }

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      void this.consumeLines(buffer, async (line, remaining) => {
        buffer = remaining;
        await processCommand(line);
      });
    });
    socket.on("error", (error) => {
      this.log.warn("pop3.socket_error", { error: `${error}` });
    });
  }

  async consumeLines(source, handler) {
    let buffer = source;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        break;
      }
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      await handler(line, buffer);
    }
  }
}
