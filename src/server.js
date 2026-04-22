import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { AdminUiServer } from "./admin.js";
import { verifyPassword } from "./auth.js";
import { buildUserDirectory } from "./config.js";
import { logger } from "./logger.js";
import { OutboundSmtpRelay } from "./outbound.js";
import { ensureTrailingCrlf, stripSmtpPath } from "./util.js";

function decodeBase64Utf8(value) {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function isMailboxAddress(address) {
  const [localPart, domain] = address.split("@");
  return Boolean(localPart && domain);
}

export class PostOfficeServer {
  constructor(config, store, log = logger, deps = {}) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.users = buildUserDirectory(config);
    this.smtpServer = undefined;
    this.submissionServer = undefined;
    this.submissionTlsServer = undefined;
    this.pop3Server = undefined;
    this.pop3TlsServer = undefined;
    this.adminServer = undefined;
    this.tlsMaterial = undefined;
    this.outboundRelay = deps.outboundRelay ?? new OutboundSmtpRelay(config, log, deps.outbound);
    this.socketGroups = {
      smtp: new Set(),
      submission: new Set(),
      submissionTls: new Set(),
      pop3: new Set(),
      pop3Tls: new Set()
    };
    this.stopping = false;
  }

  async start() {
    await this.store.initialize();
    await this.store.recoverAll();

    if (
      this.config.server.smtp.enableStartTls ||
      this.config.server.submission.enableStartTls ||
      this.config.server.submission.enableTls ||
      this.config.server.pop3.enableTls ||
      this.config.admin?.enableTls
    ) {
      this.tlsMaterial = {
        cert: await readFile(this.config.tls.certFile, "utf8"),
        key: await readFile(this.config.tls.keyFile, "utf8")
      };
    }

    this.smtpServer = net.createServer((socket) => {
      this.trackSocket(this.socketGroups.smtp, socket);
      this.handleSmtp(socket, { mode: "inbound", secure: false });
    });
    this.submissionServer = net.createServer((socket) => {
      this.trackSocket(this.socketGroups.submission, socket);
      this.handleSmtp(socket, { mode: "submission", secure: false });
    });
    this.pop3Server = net.createServer((socket) => {
      this.trackSocket(this.socketGroups.pop3, socket);
      this.handlePop3(socket, false, false);
    });

    await Promise.all([
      this.listen(this.smtpServer, this.config.server.smtp.port, this.config.server.smtp.host),
      this.listen(this.submissionServer, this.config.server.submission.port, this.config.server.submission.host),
      this.listen(this.pop3Server, this.config.server.pop3.port, this.config.server.pop3.host)
    ]);

    if (this.config.server.submission.enableTls) {
      if (!this.tlsMaterial) {
        throw new Error("Submission TLS is enabled but TLS material is unavailable");
      }

      this.submissionTlsServer = tls.createServer(
        {
          cert: this.tlsMaterial.cert,
          key: this.tlsMaterial.key
        },
        (socket) => {
          this.trackSocket(this.socketGroups.submissionTls, socket);
          this.handleSmtp(socket, { mode: "submission", secure: true });
        }
      );

      await this.listen(
        this.submissionTlsServer,
        this.config.server.submission.tlsPort,
        this.config.server.submission.host
      );
    }

    if (this.config.server.pop3.enableTls) {
      if (!this.tlsMaterial) {
        throw new Error("POP3 TLS is enabled but TLS material is unavailable");
      }

      this.pop3TlsServer = tls.createServer(
        {
          cert: this.tlsMaterial.cert,
          key: this.tlsMaterial.key
        },
        (socket) => {
          this.trackSocket(this.socketGroups.pop3Tls, socket);
          this.handlePop3(socket, true, true);
        }
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
      submissionPort: this.config.server.submission.port,
      submissionTlsPort: this.config.server.submission.enableTls ? this.config.server.submission.tlsPort : null,
      pop3Port: this.config.server.pop3.port,
      pop3TlsPort: this.config.server.pop3.enableTls ? this.config.server.pop3.tlsPort : null,
      adminPort: this.adminServer.enabled ? this.config.admin.port : null
    });
  }

  async stop() {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.destroyTrackedSockets();

    await Promise.all([
      this.closeServer(this.smtpServer),
      this.closeServer(this.submissionServer),
      this.closeServer(this.submissionTlsServer),
      this.closeServer(this.pop3Server),
      this.closeServer(this.pop3TlsServer),
      this.adminServer?.stop()
    ]);
  }

  applyConfig(nextConfig) {
    this.config = nextConfig;
    this.store.config = nextConfig;
    this.users = buildUserDirectory(nextConfig);
    this.outboundRelay.updateConfig(nextConfig);
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
      try {
        server.close((error) => {
          if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
            return;
          }

          reject(error);
        });
      } catch (error) {
        if (error?.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }

        reject(error);
      }
    });
  }

  trackSocket(group, socket) {
    group.add(socket);
    socket.on("close", () => {
      group.delete(socket);
    });
  }

  destroyTrackedSockets() {
    for (const group of Object.values(this.socketGroups)) {
      for (const socket of group) {
        socket.destroy();
      }
      group.clear();
    }
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

  getSmtpSettings(mode) {
    return mode === "submission" ? this.config.server.submission : this.config.server.smtp;
  }

  isLocalRecipient(address) {
    const [, domain] = address.split("@");
    return Boolean(domain && this.config.domains.includes(domain) && this.users.usersByAddress.has(address));
  }

  async authenticateSubmissionUser(username, password) {
    const normalized = username.trim().toLowerCase();
    const user = this.users.usersByUsername.get(normalized);
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;
    return valid ? user : null;
  }

  submissionSenderAllowed(user, address) {
    if (!user) {
      return false;
    }

    return user.addresses.includes(address);
  }

  async rejectInvalidSubmissionAuth(state, write, socket) {
    state.authFailures += 1;
    state.authContinuation = null;
    state.authLoginUsername = null;

    if (state.authFailures >= this.config.limits.maxInvalidAuthAttempts) {
      write("535 5.7.8 too many authentication failures\r\n");
      state.closed = true;
      socket.end();
      return;
    }

    write("535 5.7.8 authentication failed\r\n");
  }

  async completeSubmissionAuth(state, username, password, write, socket) {
    const user = await this.authenticateSubmissionUser(username, password);
    if (!user) {
      await this.rejectInvalidSubmissionAuth(state, write, socket);
      return;
    }

    state.authContinuation = null;
    state.authLoginUsername = null;
    state.authenticatedUser = user;
    write("235 2.7.0 authentication successful\r\n");
  }

  async handleSubmissionAuthContinuation(state, line, write, socket) {
    if (state.authContinuation === "plain") {
      const decoded = decodeBase64Utf8(line.trim());
      if (!decoded) {
        await this.rejectInvalidSubmissionAuth(state, write, socket);
        return;
      }

      const parts = decoded.split("\u0000");
      const username = parts.length >= 3 ? parts[1] : parts[0];
      const password = parts.length >= 3 ? parts[2] : parts[1];
      if (!username || !password) {
        await this.rejectInvalidSubmissionAuth(state, write, socket);
        return;
      }

      await this.completeSubmissionAuth(state, username, password, write, socket);
      return;
    }

    if (state.authContinuation === "login-username") {
      const username = decodeBase64Utf8(line.trim());
      if (!username) {
        await this.rejectInvalidSubmissionAuth(state, write, socket);
        return;
      }

      state.authContinuation = "login-password";
      state.authLoginUsername = username;
      write(`334 ${Buffer.from("Password:").toString("base64")}\r\n`);
      return;
    }

    if (state.authContinuation === "login-password") {
      const password = decodeBase64Utf8(line.trim());
      if (!password) {
        await this.rejectInvalidSubmissionAuth(state, write, socket);
        return;
      }

      await this.completeSubmissionAuth(state, state.authLoginUsername ?? "", password, write, socket);
    }
  }

  async handleSubmissionAuth(state, argument, write, socket) {
    if (state.mode !== "submission") {
      write("502 5.5.2 command not implemented\r\n");
      return;
    }

    if (state.authenticatedUser) {
      write("503 5.5.1 already authenticated\r\n");
      return;
    }

    if (!state.secure && !this.config.server.submission.allowPlaintext) {
      write("538 5.7.11 encryption required for requested authentication mechanism\r\n");
      return;
    }

    const [mechanismRaw, initialResponse = ""] = argument.split(" ");
    const mechanism = (mechanismRaw ?? "").toUpperCase();

    if (mechanism === "PLAIN") {
      if (initialResponse) {
        state.authContinuation = "plain";
        await this.handleSubmissionAuthContinuation(state, initialResponse, write, socket);
        return;
      }

      state.authContinuation = "plain";
      write("334 \r\n");
      return;
    }

    if (mechanism === "LOGIN") {
      if (initialResponse) {
        const username = decodeBase64Utf8(initialResponse);
        if (!username) {
          await this.rejectInvalidSubmissionAuth(state, write, socket);
          return;
        }

        state.authContinuation = "login-password";
        state.authLoginUsername = username;
        write(`334 ${Buffer.from("Password:").toString("base64")}\r\n`);
        return;
      }

      state.authContinuation = "login-username";
      write(`334 ${Buffer.from("Username:").toString("base64")}\r\n`);
      return;
    }

    write("504 5.5.4 unsupported authentication mechanism\r\n");
  }

  handleSmtp(rawSocket, context, sendGreeting = true) {
    let socket = rawSocket;
    const state = {
      mode: context.mode,
      secure: context.secure,
      helo: null,
      authenticatedUser: null,
      authContinuation: null,
      authLoginUsername: null,
      authFailures: 0,
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
          const rawMessage = ensureTrailingCrlf(state.dataLines.join("\r\n"));
          state.dataMode = false;
          state.dataLines = [];

          try {
            await this.acceptSmtpMessage(state, rawMessage, socket);
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

      if (state.authContinuation) {
        await this.handleSubmissionAuthContinuation(state, line, write, socket);
        return;
      }

      const [verb, ...rest] = line.split(" ");
      const command = (verb ?? "").toUpperCase();
      const argument = rest.join(" ").trim();
      const smtpSettings = this.getSmtpSettings(state.mode);

      switch (command) {
        case "EHLO":
        case "HELO":
          state.helo = argument || "unknown";
          state.authContinuation = null;
          state.authLoginUsername = null;
          resetMessage();
          if (command === "EHLO") {
            const lines = [`250-${this.config.server.smtp.hostname}`];
            if (smtpSettings.enableStartTls && !state.secure) {
              lines.push("250-STARTTLS");
            }
            if (state.mode === "submission") {
              lines.push("250-AUTH PLAIN LOGIN");
            }
            lines.push(`250 SIZE ${this.config.limits.maxMessageBytes}`);
            write(`${lines.join("\r\n")}\r\n`);
          } else {
            write(`250 ${this.config.server.smtp.hostname}\r\n`);
          }
          return;
        case "STARTTLS":
          if (!smtpSettings.enableStartTls) {
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
          this.handleSmtp(socket, { mode: state.mode, secure: true }, false);
          return;
        case "AUTH":
          if (!state.helo) {
            write("503 5.5.1 send HELO/EHLO first\r\n");
            return;
          }
          await this.handleSubmissionAuth(state, argument, write, socket);
          return;
        case "MAIL":
          if (!state.helo) {
            write("503 5.5.1 send HELO/EHLO first\r\n");
            return;
          }
          if (state.mode === "submission" && !state.authenticatedUser) {
            write("530 5.7.0 authentication required\r\n");
            return;
          }
          if (!/^FROM:/i.test(argument)) {
            write("501 5.5.4 malformed MAIL FROM\r\n");
            return;
          }
          resetMessage();
          state.mailFrom = stripSmtpPath(argument.slice(5).trim());
          if (state.mode === "submission" && !this.submissionSenderAllowed(state.authenticatedUser, state.mailFrom)) {
            write("553 5.7.1 sender address not owned by authenticated user\r\n");
            state.mailFrom = null;
            return;
          }
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
            if (!isMailboxAddress(address)) {
              write("501 5.1.3 bad recipient address syntax\r\n");
              return;
            }

            if (state.mode === "inbound" && !this.isLocalRecipient(address)) {
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
          state.authContinuation = null;
          state.authLoginUsername = null;
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

  async storeLocalMessage(recipients, state, rawMessage, socket, event) {
    const delivered = new Set();

    for (const address of recipients) {
      const user = this.users.usersByAddress.get(address);
      if (!user || delivered.has(user.mailbox)) {
        continue;
      }

      delivered.add(user.mailbox);
      await this.store.deliver(user.mailbox, {
        mailFrom: state.mailFrom,
        rcptTo: recipients,
        rawMessage,
        remoteAddress: socket.remoteAddress ?? null
      });
    }

    this.log.info(event, {
      recipients,
      secure: state.secure,
      remoteAddress: socket.remoteAddress ?? null,
      username: state.authenticatedUser?.username ?? null
    });
  }

  async acceptSmtpMessage(state, rawMessage, socket) {
    if (state.mode === "submission") {
      if (state.rcptTo.every((address) => this.isLocalRecipient(address))) {
        await this.storeLocalMessage(state.rcptTo, state, rawMessage, socket, "smtp.submission_stored");
        return;
      }

      await this.outboundRelay.deliver({
        mailFrom: state.mailFrom,
        rcptTo: state.rcptTo,
        rawMessage
      });

      this.log.info("smtp.submission_sent", {
        recipients: state.rcptTo,
        secure: state.secure,
        remoteAddress: socket.remoteAddress ?? null,
        username: state.authenticatedUser?.username ?? null
      });
      return;
    }

    await this.storeLocalMessage(state.rcptTo, state, rawMessage, socket, "smtp.message_stored");
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
