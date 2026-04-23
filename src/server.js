import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { join } from "node:path";
import { AdminUiServer } from "./admin.js";
import { authenticateUser, normalizeLoginIdentifier } from "./accounts.js";
import { buildUserDirectory } from "./config.js";
import { ImapConnectionHandler } from "./imap.js";
import { logger } from "./logger.js";
import { OutboundSmtpRelay } from "./outbound.js";
import { endStream, ensureDirectory, ensureTrailingCrlf, generateMessageId, stripSmtpPath, writeToStream } from "./util.js";
import { APP_VERSION } from "./version.js";

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

function canWriteToSocket(socket) {
  return Boolean(socket && typeof socket.write === "function" && !socket.destroyed && socket.writable);
}

function safeSocketWrite(socket, message) {
  if (!canWriteToSocket(socket)) {
    return false;
  }

  try {
    socket.write(message);
    return true;
  } catch {
    return false;
  }
}

function safeSocketEnd(socket) {
  if (!socket || typeof socket.end !== "function") {
    return;
  }

  try {
    socket.end();
  } catch {
    try {
      socket.destroy();
    } catch {}
  }
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
    this.imapServer = undefined;
    this.imapTlsServer = undefined;
    this.adminServer = undefined;
    this.tlsMaterial = undefined;
    this.outboundRelay = deps.outboundRelay ?? new OutboundSmtpRelay(config, log, deps.outbound);
    this.imapHandler = new ImapConnectionHandler(config, store, this.users, log);
    this.socketGroups = {
      smtp: new Set(),
      submission: new Set(),
      submissionTls: new Set(),
      pop3: new Set(),
      pop3Tls: new Set(),
      imap: new Set(),
      imapTls: new Set()
    };
    this.stopping = false;
  }

  isTlsEnabled(config = this.config) {
    return Boolean(
      config.server.smtp.enableStartTls ||
        config.server.submission.enableStartTls ||
        config.server.submission.enableTls ||
        config.server.pop3.enableTls ||
        config.server.imap.enableStartTls ||
        config.server.imap.enableTls ||
        config.admin?.enableTls
    );
  }

  async loadTlsMaterial() {
    return {
      cert: await readFile(this.config.tls.certFile, "utf8"),
      key: await readFile(this.config.tls.keyFile, "utf8")
    };
  }

  async start() {
    await this.store.initialize();
    await this.store.recoverAll();

    if (this.isTlsEnabled()) {
      this.tlsMaterial = await this.loadTlsMaterial();
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
    if (this.config.server.imap.allowPlaintext || this.config.server.imap.enableStartTls) {
      this.imapServer = net.createServer((socket) => {
        this.trackSocket(this.socketGroups.imap, socket);
        this.imapHandler.handle(socket, false);
      });
    }

    const listeners = [
      this.listen(this.smtpServer, this.config.server.smtp.port, this.config.server.smtp.host),
      this.listen(this.submissionServer, this.config.server.submission.port, this.config.server.submission.host),
      this.listen(this.pop3Server, this.config.server.pop3.port, this.config.server.pop3.host)
    ];
    if (this.imapServer) {
      listeners.push(this.listen(this.imapServer, this.config.server.imap.port, this.config.server.imap.host));
    }
    await Promise.all(listeners);

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

    if (this.config.server.imap.enableTls) {
      if (!this.tlsMaterial) {
        throw new Error("IMAP TLS is enabled but TLS material is unavailable");
      }

      this.imapTlsServer = tls.createServer(
        {
          cert: this.tlsMaterial.cert,
          key: this.tlsMaterial.key
        },
        (socket) => {
          this.trackSocket(this.socketGroups.imapTls, socket);
          this.imapHandler.handle(socket, true);
        }
      );

      await this.listen(this.imapTlsServer, this.config.server.imap.tlsPort, this.config.server.imap.host);
    }

    this.adminServer = new AdminUiServer(
      this.config,
      (nextConfig) => this.applyConfig(nextConfig),
      this.log,
      this.tlsMaterial
    );
    await this.adminServer.start();

    this.log.info("server.started", {
      version: APP_VERSION,
      smtpPort: this.config.server.smtp.port,
      submissionPort: this.config.server.submission.port,
      submissionTlsPort: this.config.server.submission.enableTls ? this.config.server.submission.tlsPort : null,
      pop3Port: this.config.server.pop3.port,
      pop3TlsPort: this.config.server.pop3.enableTls ? this.config.server.pop3.tlsPort : null,
      imapPort: this.imapServer ? this.config.server.imap.port : null,
      imapTlsPort: this.config.server.imap.enableTls ? this.config.server.imap.tlsPort : null,
      adminPort: this.adminServer.enabled ? this.config.admin.port : null
    });
  }

  async reloadTlsMaterial() {
    if (!this.isTlsEnabled()) {
      this.tlsMaterial = undefined;
      return false;
    }

    const nextTlsMaterial = await this.loadTlsMaterial();
    this.tlsMaterial = nextTlsMaterial;

    if (this.submissionTlsServer?.setSecureContext) {
      this.submissionTlsServer.setSecureContext(nextTlsMaterial);
    }

    if (this.pop3TlsServer?.setSecureContext) {
      this.pop3TlsServer.setSecureContext(nextTlsMaterial);
    }

    if (this.imapTlsServer?.setSecureContext) {
      this.imapTlsServer.setSecureContext(nextTlsMaterial);
    }

    this.adminServer?.updateTlsMaterial(nextTlsMaterial);
    return true;
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
      this.closeServer(this.imapServer),
      this.closeServer(this.imapTlsServer),
      this.adminServer?.stop()
    ]);
  }

  applyConfig(nextConfig) {
    this.config = nextConfig;
    this.store.config = nextConfig;
    this.users = buildUserDirectory(nextConfig);
    this.imapHandler = new ImapConnectionHandler(nextConfig, this.store, this.users, this.log);
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

    const secureContext = tls.createSecureContext({
      cert: this.tlsMaterial.cert,
      key: this.tlsMaterial.key
    });

    return new tls.TLSSocket(socket, {
      isServer: true,
      secureContext
    });
  }

  attachCommonSocketState(socket) {
    socket.setTimeout(this.config.limits.socketTimeoutMs, () => {
      safeSocketWrite(socket, "-ERR inactivity timeout\r\n");
      safeSocketEnd(socket);
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
    return await authenticateUser(this.users, username, password);
  }

  submissionSenderAllowed(user, address) {
    if (!user) {
      return false;
    }

    if (user.addresses.includes(address)) {
      return true;
    }

    const [localPart, domain] = address.split("@");
    return Boolean(localPart && domain && localPart === user.username && this.config.domains.includes(domain));
  }

  async rejectInvalidSubmissionAuth(state, write, socket) {
    state.authFailures += 1;
    state.authContinuation = null;
    state.authLoginUsername = null;

    if (state.authFailures >= this.config.limits.maxInvalidAuthAttempts) {
      write("535 5.7.8 too many authentication failures\r\n");
      state.closed = true;
      safeSocketEnd(socket);
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
      dataTempPath: null,
      dataWriter: null,
      dataBytes: 0,
      closed: false
    };
    const remoteAddress = socket.remoteAddress ?? null;
    const remotePort = socket.remotePort ?? null;

    const resetMessage = () => {
      state.mailFrom = null;
      state.rcptTo = [];
      state.dataMode = false;
      state.dataTempPath = null;
      state.dataWriter = null;
      state.dataBytes = 0;
    };

    const write = (message) => {
      if (!state.closed) {
        safeSocketWrite(socket, message);
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
          const filePath = state.dataTempPath;
          const writer = state.dataWriter;
          state.dataMode = false;
          state.dataTempPath = null;
          state.dataWriter = null;

          try {
            await endStream(writer);
            await this.acceptSmtpMessage(state, {
              filePath,
              size: state.dataBytes
            }, socket);
            write("250 2.0.0 message accepted\r\n");
          } catch (error) {
            this.log.error("smtp.delivery_failed", { error: `${error}` });
            write(`552 5.3.4 ${String(error instanceof Error ? error.message : error)}\r\n`);
          } finally {
            if (filePath) {
              await rm(filePath, { force: true }).catch(() => {});
            }
            resetMessage();
          }
          return;
        }

        const unescaped = line.startsWith("..") ? line.slice(1) : line;
        state.dataBytes += Buffer.byteLength(unescaped, "utf8") + 2;
        if (state.dataBytes > this.config.limits.maxMessageBytes) {
          if (state.dataWriter) {
            await endStream(state.dataWriter).catch(() => {});
          }
          if (state.dataTempPath) {
            await rm(state.dataTempPath, { force: true }).catch(() => {});
          }
          resetMessage();
          write("552 5.3.4 message too large\r\n");
          return;
        }

        await writeToStream(state.dataWriter, `${unescaped}\r\n`);
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

      if (["EHLO", "HELO", "MAIL", "RCPT", "DATA", "QUIT", "RSET", "STARTTLS"].includes(command)) {
        this.log.info("smtp.command", {
          mode: state.mode,
          secure: state.secure,
          remoteAddress,
          remotePort,
          command,
          argument: command === "DATA" ? null : argument || null,
          mailFrom: state.mailFrom,
          rcptCount: state.rcptTo.length
        });
      }

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
            this.log.warn("smtp.submission_sender_rejected", {
              attemptedSender: state.mailFrom,
              username: state.authenticatedUser?.username ?? null,
              allowedAddresses: state.authenticatedUser?.addresses ?? []
            });
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
          await ensureDirectory(join(this.config.storage.rootDir, "incoming"));
          state.dataTempPath = join(
            this.config.storage.rootDir,
            "incoming",
            `${generateMessageId(this.config.server.smtp.hostname)}.smtp.tmp`
          );
          state.dataWriter = createWriteStream(state.dataTempPath, { encoding: "utf8" });
          state.dataMode = true;
          state.dataBytes = 0;
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
          safeSocketEnd(socket);
          return;
        default:
          write("502 5.5.2 command not implemented\r\n");
      }
    };

    this.attachCommonSocketState(socket);
    this.log.info("smtp.connection_opened", {
      mode: state.mode,
      secure: state.secure,
      remoteAddress,
      remotePort
    });
    if (sendGreeting) {
      write(`220 ${this.config.server.smtp.hostname} ESMTP PostOfficeX\r\n`);
    }

    let buffer = "";
    let readLoop = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      readLoop = readLoop
        .then(async () => {
          await this.consumeLines(() => buffer, async (line, remaining) => {
            buffer = remaining;
            await processLine(line);
          });
        })
        .catch((error) => {
          this.log.error("smtp.read_failed", {
            mode: state.mode,
            secure: state.secure,
            remoteAddress,
            remotePort,
            error: `${error}`
          });
          if (!state.closed) {
            safeSocketEnd(socket);
          }
        });
    });

    socket.on("error", (error) => {
      this.log.warn("smtp.socket_error", {
        mode: state.mode,
        secure: state.secure,
        remoteAddress,
        remotePort,
        error: `${error}`
      });
    });
    socket.on("close", () => {
      state.closed = true;
      this.log.info("smtp.connection_closed", {
        mode: state.mode,
        secure: state.secure,
        remoteAddress,
        remotePort,
        mailFrom: state.mailFrom,
        rcptCount: state.rcptTo.length
      });
    });
  }

  async storeLocalMessage(recipients, state, messageSource, socket, event) {
    const delivered = new Set();

    for (const address of recipients) {
      const user = this.users.usersByAddress.get(address);
      if (!user || delivered.has(user.mailbox)) {
        continue;
      }

      delivered.add(user.mailbox);
      const metadata = await this.store.deliverFromFile(user.mailbox, {
        filePath: messageSource.filePath,
        size: messageSource.size,
        mailFrom: state.mailFrom,
        rcptTo: recipients,
        remoteAddress: socket.remoteAddress ?? null
      });

      this.log.info("mailbox.message_stored", {
        mailbox: user.mailbox,
        messageId: metadata.id,
        subject: metadata.subject,
        headerFrom: metadata.from,
        envelopeFrom: state.mailFrom,
        recipients: metadata.envelope.rcptTo,
        size: metadata.size,
        secure: state.secure,
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

  async acceptSmtpMessage(state, messageSource, socket) {
    if (state.mode === "submission") {
      const localRecipients = state.rcptTo.filter((address) => this.isLocalRecipient(address));
      const remoteRecipients = state.rcptTo.filter((address) => !this.isLocalRecipient(address));

      if (localRecipients.length > 0) {
        await this.storeLocalMessage(localRecipients, state, messageSource, socket, "smtp.submission_stored");
      }

      if (remoteRecipients.length === 0) {
        return;
      }

      await this.outboundRelay.deliverFromFile({
        mailFrom: state.mailFrom,
        rcptTo: remoteRecipients,
        filePath: messageSource.filePath
      });

      this.log.info("smtp.submission_sent", {
        recipients: remoteRecipients,
        secure: state.secure,
        remoteAddress: socket.remoteAddress ?? null,
        username: state.authenticatedUser?.username ?? null
      });
      return;
    }

    await this.storeLocalMessage(state.rcptTo, state, messageSource, socket, "smtp.message_stored");
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
      safeSocketWrite(socket, message);
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
            if (!this.config.server.pop3.enableStartTls) {
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
            state.username = normalizeLoginIdentifier(argument);
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
              const user = await authenticateUser(this.users, state.username, argument);
              if (!user) {
                state.authFailures += 1;
                if (state.authFailures >= this.config.limits.maxInvalidAuthAttempts) {
                  write("-ERR too many auth failures\r\n");
                  safeSocketEnd(socket);
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
            safeSocketEnd(socket);
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
          safeSocketEnd(socket);
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
    let readLoop = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      readLoop = readLoop
        .then(async () => {
          await this.consumeLines(() => buffer, async (line, remaining) => {
            buffer = remaining;
            await processCommand(line);
          });
        })
        .catch((error) => {
          this.log.error("pop3.read_failed", { error: `${error}` });
          safeSocketEnd(socket);
        });
    });
    socket.on("error", (error) => {
      this.log.warn("pop3.socket_error", { error: `${error}` });
    });
  }

  async consumeLines(readBuffer, handler) {
    while (true) {
      const buffer = await readBuffer();
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        break;
      }
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      await handler(line, buffer.slice(idx + 1));
    }
  }
}
