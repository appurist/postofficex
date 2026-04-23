import { authenticateUser } from "./accounts.js";
import { ensureTrailingCrlf, splitMessage, parseHeaders } from "./util.js";

const CAPABILITIES = ["IMAP4rev1", "IDLE", "UIDPLUS", "AUTH=PLAIN"];
const SYSTEM_FLAGS = ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft"];

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

function quoteImap(value) {
  return `"${`${value ?? ""}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatFlagList(flags = []) {
  return `(${flags.join(" ")})`;
}

function formatInternalDate(value) {
  const date = new Date(value);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  const seconds = `${date.getUTCSeconds()}`.padStart(2, "0");
  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds} +0000`;
}

function decodeMailboxName(value) {
  const parsed = parseAString(value);
  return parsed?.value ?? "";
}

function stripOuterParens(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseAString(input, start = 0) {
  let index = start;
  while (index < input.length && input[index] === " ") {
    index += 1;
  }
  if (index >= input.length) {
    return null;
  }
  if (input[index] === '"') {
    let value = "";
    index += 1;
    while (index < input.length) {
      const char = input[index];
      if (char === "\\") {
        index += 1;
        value += input[index] ?? "";
        index += 1;
        continue;
      }
      if (char === '"') {
        index += 1;
        return { value, nextIndex: index };
      }
      value += char;
      index += 1;
    }
    return null;
  }

  const begin = index;
  while (index < input.length && input[index] !== " ") {
    index += 1;
  }
  return { value: input.slice(begin, index), nextIndex: index };
}

function splitTopLevel(value) {
  const items = [];
  let current = "";
  let depth = 0;
  let bracketDepth = 0;
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      current += char;
      if (char === "\\") {
        current += value[index + 1] ?? "";
        index += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      current += char;
      continue;
    }
    if (char === " " && depth === 0 && bracketDepth === 0) {
      if (current) {
        items.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    items.push(current);
  }
  return items;
}

function parseFlagList(value) {
  const inner = stripOuterParens(value);
  if (!inner) {
    return [];
  }
  return splitTopLevel(inner);
}

function parseSequenceSet(value, max) {
  if (!value || max <= 0) {
    return [];
  }
  const resolved = new Set();
  const normalizePart = (part) => {
    if (part === "*") {
      return max;
    }
    const numeric = Number(part);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  };

  for (const range of value.split(",")) {
    const [startRaw, endRaw] = range.split(":");
    const start = normalizePart(startRaw);
    const end = endRaw ? normalizePart(endRaw) : start;
    if (!start || !end) {
      continue;
    }
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    for (let current = low; current <= high; current += 1) {
      if (current >= 1 && current <= max) {
        resolved.add(current);
      }
    }
  }

  return Array.from(resolved).sort((a, b) => a - b);
}

function splitHeaderFields(raw) {
  const { headerText } = splitMessage(raw);
  return headerText ? `${headerText}\r\n\r\n` : "\r\n";
}

function filterHeaderFields(raw, fields) {
  const { headerText } = splitMessage(raw);
  const headers = parseHeaders(headerText);
  const wanted = new Set(fields.map((field) => field.toLowerCase()));
  const lines = [];

  for (const line of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines.push(line);
      continue;
    }
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const name = line.slice(0, index).trim().toLowerCase();
    if (wanted.has(name) && headers.has(name)) {
      lines.push(line);
    }
  }

  return lines.length > 0 ? `${lines.join("\r\n")}\r\n\r\n` : "\r\n";
}

function bodyText(raw) {
  return splitMessage(raw).bodyText;
}

function formatListAttributes(folderName, allFolderNames) {
  const hasChildren = allFolderNames.some((item) => item !== folderName && item.startsWith(`${folderName}/`));
  return hasChildren ? "(\\HasChildren)" : "(\\HasNoChildren)";
}

export class ImapConnectionHandler {
  constructor(config, store, users, log) {
    this.config = config;
    this.store = store;
    this.users = users;
    this.log = log;
  }

  handle(socket, secure) {
    const state = {
      secure,
      authenticatedUser: null,
      selectedFolder: null,
      selectedReadOnly: false,
      selectedSnapshot: [],
      idleTag: null,
      idleStop: null,
      closed: false,
      buffer: Buffer.alloc(0),
      literalPending: null
    };

    const write = (message) => {
      if (!state.closed) {
        safeSocketWrite(socket, message);
      }
    };

    const sendTagged = (tag, status, message) => {
      write(`${tag} ${status} ${message}\r\n`);
    };

    const updateSelectedSnapshot = async () => {
      if (!state.authenticatedUser || !state.selectedFolder) {
        state.selectedSnapshot = [];
        return [];
      }
      state.selectedSnapshot = await this.store.listFolderMessages(state.authenticatedUser.mailbox, state.selectedFolder);
      return state.selectedSnapshot;
    };

    const sequenceForUid = (uid) => state.selectedSnapshot.findIndex((item) => item.uid === uid) + 1;

    const endIdle = (completed = true) => {
      if (!state.idleTag) {
        return;
      }
      state.idleStop?.();
      const tag = state.idleTag;
      state.idleTag = null;
      state.idleStop = null;
      if (completed) {
        sendTagged(tag, "OK", "IDLE terminated");
      }
    };

    const publishSelectedStatus = async (folderName, readOnly) => {
      const status = await this.store.getFolderStatus(state.authenticatedUser.mailbox, folderName);
      const unseenMessage = status.messages.find((item) => !(item.flags ?? []).includes("\\Seen"));
      write(`* ${status.exists} EXISTS\r\n`);
      write(`* ${status.recent} RECENT\r\n`);
      write(`* OK [UIDVALIDITY ${status.uidValidity}] UIDs valid\r\n`);
      write(`* OK [UIDNEXT ${status.uidNext}] Predicted next UID\r\n`);
      if (unseenMessage) {
        const unseenSequence = status.messages.findIndex((item) => item.uid === unseenMessage.uid) + 1;
        write(`* OK [UNSEEN ${unseenSequence}] First unseen message\r\n`);
      }
      write(`* FLAGS ${formatFlagList(SYSTEM_FLAGS)}\r\n`);
      write(`* OK [PERMANENTFLAGS ${formatFlagList(SYSTEM_FLAGS)}] Limited\r\n`);
      state.selectedFolder = status.name;
      state.selectedReadOnly = readOnly;
      state.selectedSnapshot = status.messages;
      await this.store.clearRecent(state.authenticatedUser.mailbox, status.name);
    };

    const notifySelectedChange = async (event) => {
      if (!state.authenticatedUser || !state.selectedFolder || event.folder !== state.selectedFolder) {
        return;
      }

      const previous = state.selectedSnapshot;
      const current = await updateSelectedSnapshot();

      if (event.type === "append") {
        write(`* ${current.length} EXISTS\r\n`);
        return;
      }

      if (event.type === "flags" && event.uid) {
        const record = current.find((item) => item.uid === event.uid);
        const sequence = sequenceForUid(event.uid);
        if (record && sequence > 0) {
          write(`* ${sequence} FETCH (FLAGS ${formatFlagList(record.flags)} UID ${record.uid})\r\n`);
        }
        return;
      }

      if (event.type === "expunge") {
        const removed = event.removedUids ?? [];
        for (const uid of removed) {
          const sequence = previous.findIndex((item) => item.uid === uid) + 1;
          if (sequence > 0) {
            write(`* ${sequence} EXPUNGE\r\n`);
          }
        }
        write(`* ${current.length} EXISTS\r\n`);
      }
    };

    const resolveMessages = (sequenceSet, useUid) => {
      const items = state.selectedSnapshot;
      if (useUid) {
        const uidMatches = new Set(parseSequenceSet(sequenceSet, Math.max(...items.map((item) => item.uid), 0)));
        return items
          .map((item, index) => ({ ...item, sequence: index + 1 }))
          .filter((item) => uidMatches.has(item.uid));
      }
      return parseSequenceSet(sequenceSet, items.length).map((sequence) => ({
        ...items[sequence - 1],
        sequence
      }));
    };

    const renderFetchItem = async (message, item) => {
      const upper = item.toUpperCase();
      if (upper === "UID") {
        return `UID ${message.uid}`;
      }
      if (upper === "FLAGS") {
        return `FLAGS ${formatFlagList(message.flags)}`;
      }
      if (upper === "RFC822.SIZE") {
        return `RFC822.SIZE ${message.size}`;
      }
      if (upper === "INTERNALDATE") {
        return `INTERNALDATE "${formatInternalDate(message.internalDate)}"`;
      }

      const raw = await this.store.getMessageBlob(state.authenticatedUser.mailbox, message.messageId);
      if (upper === "BODY[]" || upper === "RFC822") {
        return `${item} {${Buffer.byteLength(raw, "utf8")}}\r\n${ensureTrailingCrlf(raw)}`;
      }
      if (upper === "BODY[HEADER]" || upper === "BODY.PEEK[HEADER]" || upper === "RFC822.HEADER") {
        const headers = splitHeaderFields(raw);
        return `${item} {${Buffer.byteLength(headers, "utf8")}}\r\n${headers}`;
      }
      if (upper === "BODY[TEXT]" || upper === "BODY.PEEK[TEXT]" || upper === "RFC822.TEXT") {
        const text = ensureTrailingCrlf(bodyText(raw));
        return `${item} {${Buffer.byteLength(text, "utf8")}}\r\n${text}`;
      }

      const headerFields = upper.match(/^BODY(?:\.PEEK)?\[HEADER\.FIELDS\s+\((.+)\)\]$/);
      if (headerFields) {
        const fields = splitTopLevel(headerFields[1]).map((field) => field.replace(/^"|"$/g, ""));
        const filtered = filterHeaderFields(raw, fields);
        return `${item} {${Buffer.byteLength(filtered, "utf8")}}\r\n${filtered}`;
      }

      throw new Error(`Unsupported FETCH item: ${item}`);
    };

    const parseFetchItems = (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return ["FLAGS"];
      }
      const upper = trimmed.toUpperCase();
      if (upper === "ALL") {
        return ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"];
      }
      if (upper === "FAST") {
        return ["FLAGS", "INTERNALDATE", "RFC822.SIZE"];
      }
      if (upper === "FULL") {
        return ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "BODY[]"];
      }
      return splitTopLevel(stripOuterParens(trimmed));
    };

    const performFetch = async (tag, sequenceSet, rawItems, useUid) => {
      if (!state.selectedFolder) {
        sendTagged(tag, "BAD", "No mailbox selected");
        return;
      }
      const items = parseFetchItems(rawItems);
      const messages = resolveMessages(sequenceSet, useUid);
      for (const message of messages) {
        const parts = [];
        for (const item of items) {
          if (item.toUpperCase() === "ENVELOPE") {
            parts.push(`ENVELOPE (${quoteImap(message.subject ?? "")} NIL NIL NIL NIL NIL NIL NIL NIL NIL)`);
            continue;
          }
          parts.push(await renderFetchItem(message, item));
        }
        write(`* ${message.sequence} FETCH (${parts.join(" ")})\r\n`);
      }
      sendTagged(tag, "OK", "FETCH completed");
    };

    const performStore = async (tag, sequenceSet, operationToken, flagValue, useUid) => {
      if (!state.selectedFolder || state.selectedReadOnly) {
        sendTagged(tag, "NO", "Mailbox is read-only");
        return;
      }
      const upper = operationToken.toUpperCase();
      const silent = upper.endsWith(".SILENT");
      const mode = upper.startsWith("+FLAGS") ? "add" : upper.startsWith("-FLAGS") ? "remove" : "set";
      const messages = resolveMessages(sequenceSet, useUid);
      const changed = await this.store.updateMessageFlags(
        state.authenticatedUser.mailbox,
        state.selectedFolder,
        messages.map((item) => item.uid),
        mode,
        parseFlagList(flagValue)
      );
      await updateSelectedSnapshot();
      if (!silent) {
        for (const item of changed) {
          const sequence = sequenceForUid(item.uid);
          if (sequence > 0) {
            write(`* ${sequence} FETCH (FLAGS ${formatFlagList(item.flags)} UID ${item.uid})\r\n`);
          }
        }
      }
      sendTagged(tag, "OK", "STORE completed");
    };

    const searchMessages = async (tag, criteriaRaw, useUid) => {
      if (!state.selectedFolder) {
        sendTagged(tag, "BAD", "No mailbox selected");
        return;
      }
      const tokens = splitTopLevel(criteriaRaw.trim());
      let matches = state.selectedSnapshot.map((item, index) => ({ ...item, sequence: index + 1 }));

      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index].toUpperCase();
        if (token === "ALL") {
          continue;
        }
        if (token === "UNSEEN") {
          matches = matches.filter((item) => !(item.flags ?? []).includes("\\Seen"));
          continue;
        }
        if (token === "SEEN") {
          matches = matches.filter((item) => (item.flags ?? []).includes("\\Seen"));
          continue;
        }
        if (token === "DELETED") {
          matches = matches.filter((item) => (item.flags ?? []).includes("\\Deleted"));
          continue;
        }
        if (token === "UNDELETED") {
          matches = matches.filter((item) => !(item.flags ?? []).includes("\\Deleted"));
          continue;
        }
        if (token === "UID") {
          const setValue = tokens[index + 1] ?? "";
          const allowed = new Set(
            parseSequenceSet(setValue, Math.max(...matches.map((item) => item.uid), 0))
          );
          matches = matches.filter((item) => allowed.has(item.uid));
          index += 1;
          continue;
        }
        if (token === "HEADER") {
          const fieldToken = tokens[index + 1] ?? "";
          const valueToken = decodeMailboxName(tokens[index + 2] ?? "");
          const fieldName = decodeMailboxName(fieldToken);
          matches = matches.filter((item) => {
            const candidate = `${item[fieldName.toLowerCase()] ?? item.subject ?? ""}`.toLowerCase();
            return candidate.includes(valueToken.toLowerCase());
          });
          index += 2;
          continue;
        }
      }

      const response = matches.map((item) => (useUid ? item.uid : item.sequence)).join(" ");
      write(`* SEARCH${response ? ` ${response}` : ""}\r\n`);
      sendTagged(tag, "OK", "SEARCH completed");
    };

    const handleCommand = async (line, literal) => {
      if (state.idleTag && line === "DONE") {
        endIdle(true);
        return;
      }

      const firstSpace = line.indexOf(" ");
      if (firstSpace === -1) {
        write(`* BAD malformed command\r\n`);
        return;
      }
      const tag = line.slice(0, firstSpace);
      const remainder = line.slice(firstSpace + 1).trim();
      const secondSpace = remainder.indexOf(" ");
      const command = (secondSpace === -1 ? remainder : remainder.slice(0, secondSpace)).toUpperCase();
      const argument = secondSpace === -1 ? "" : remainder.slice(secondSpace + 1).trim();

      try {
        switch (command) {
          case "CAPABILITY":
            write(`* CAPABILITY ${CAPABILITIES.join(" ")}\r\n`);
            sendTagged(tag, "OK", "CAPABILITY completed");
            return;
          case "NOOP":
            sendTagged(tag, "OK", "NOOP completed");
            return;
          case "LOGOUT":
            write("* BYE logging out\r\n");
            sendTagged(tag, "OK", "LOGOUT completed");
            state.closed = true;
            safeSocketEnd(socket);
            return;
          case "LOGIN": {
            if (!state.secure && !this.config.server.imap.allowPlaintext) {
              sendTagged(tag, "NO", "Plaintext authentication disabled");
              return;
            }
            const first = parseAString(argument);
            const second = first ? parseAString(argument, first.nextIndex) : null;
            const user = await authenticateUser(this.users, first?.value ?? "", second?.value ?? "");
            if (!user) {
              sendTagged(tag, "NO", "Authentication failed");
              return;
            }
            state.authenticatedUser = user;
            sendTagged(tag, "OK", "LOGIN completed");
            return;
          }
          case "AUTHENTICATE": {
            const mechanism = argument.toUpperCase();
            if (mechanism !== "PLAIN") {
              sendTagged(tag, "NO", "Unsupported authentication mechanism");
              return;
            }
            write("+ \r\n");
            state.literalPending = { tag, authPlain: true };
            return;
          }
        }

        if (!state.authenticatedUser) {
          sendTagged(tag, "BAD", "Authenticate first");
          return;
        }

        switch (command) {
          case "LIST":
          case "LSUB": {
            const folders = await this.store.listFolders(state.authenticatedUser.mailbox);
            const visible = command === "LSUB" ? folders.filter((item) => item.subscribed) : folders;
            for (const folder of visible) {
              write(`* ${command} ${formatListAttributes(folder.name, folders.map((item) => item.name))} "/" ${quoteImap(folder.name)}\r\n`);
            }
            sendTagged(tag, "OK", `${command} completed`);
            return;
          }
          case "SELECT":
          case "EXAMINE":
            await publishSelectedStatus(decodeMailboxName(argument), command === "EXAMINE");
            state.idleStop?.();
            state.idleStop = this.store.subscribeToFolder(
              state.authenticatedUser.mailbox,
              state.selectedFolder,
              (event) => void notifySelectedChange(event)
            );
            sendTagged(tag, "OK", `[${command === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${command} completed`);
            return;
          case "CREATE":
            await this.store.createFolder(state.authenticatedUser.mailbox, decodeMailboxName(argument));
            sendTagged(tag, "OK", "CREATE completed");
            return;
          case "DELETE":
            await this.store.deleteFolder(state.authenticatedUser.mailbox, decodeMailboxName(argument));
            if (state.selectedFolder === decodeMailboxName(argument)) {
              state.selectedFolder = null;
              state.selectedSnapshot = [];
            }
            sendTagged(tag, "OK", "DELETE completed");
            return;
          case "RENAME": {
            const source = parseAString(argument);
            const target = source ? parseAString(argument, source.nextIndex) : null;
            await this.store.renameFolder(state.authenticatedUser.mailbox, source?.value ?? "", target?.value ?? "");
            if (state.selectedFolder === source?.value) {
              state.selectedFolder = target?.value ?? null;
            }
            sendTagged(tag, "OK", "RENAME completed");
            return;
          }
          case "SUBSCRIBE":
            await this.store.setFolderSubscription(state.authenticatedUser.mailbox, decodeMailboxName(argument), true);
            sendTagged(tag, "OK", "SUBSCRIBE completed");
            return;
          case "UNSUBSCRIBE":
            await this.store.setFolderSubscription(state.authenticatedUser.mailbox, decodeMailboxName(argument), false);
            sendTagged(tag, "OK", "UNSUBSCRIBE completed");
            return;
          case "STATUS": {
            const mailboxToken = parseAString(argument);
            const itemsRaw = argument.slice(mailboxToken?.nextIndex ?? 0).trim();
            const status = await this.store.getFolderStatus(
              state.authenticatedUser.mailbox,
              mailboxToken?.value ?? ""
            );
            const requested = splitTopLevel(stripOuterParens(itemsRaw).toUpperCase());
            const values = [];
            for (const item of requested) {
              if (item === "MESSAGES") {
                values.push(`MESSAGES ${status.exists}`);
              } else if (item === "RECENT") {
                values.push(`RECENT ${status.recent}`);
              } else if (item === "UIDNEXT") {
                values.push(`UIDNEXT ${status.uidNext}`);
              } else if (item === "UIDVALIDITY") {
                values.push(`UIDVALIDITY ${status.uidValidity}`);
              } else if (item === "UNSEEN") {
                values.push(`UNSEEN ${status.unseen}`);
              }
            }
            write(`* STATUS ${quoteImap(status.name)} (${values.join(" ")})\r\n`);
            sendTagged(tag, "OK", "STATUS completed");
            return;
          }
          case "FETCH": {
            const [sequenceSet, ...rest] = splitTopLevel(argument);
            await updateSelectedSnapshot();
            await performFetch(tag, sequenceSet, rest.join(" "), false);
            return;
          }
          case "STORE": {
            const [sequenceSet, operationToken, ...rest] = splitTopLevel(argument);
            await updateSelectedSnapshot();
            await performStore(tag, sequenceSet, operationToken, rest.join(" "), false);
            return;
          }
          case "SEARCH":
            await updateSelectedSnapshot();
            await searchMessages(tag, argument || "ALL", false);
            return;
          case "COPY": {
            const parts = splitTopLevel(argument);
            const sequenceSet = parts.shift();
            const folderName = decodeMailboxName(parts.join(" "));
            await updateSelectedSnapshot();
            await this.store.copyMessages(
              state.authenticatedUser.mailbox,
              state.selectedFolder,
              folderName,
              resolveMessages(sequenceSet, false).map((item) => item.uid)
            );
            sendTagged(tag, "OK", "COPY completed");
            return;
          }
          case "EXPUNGE": {
            await updateSelectedSnapshot();
            const previous = state.selectedSnapshot.slice();
            const removed = await this.store.expungeDeleted(state.authenticatedUser.mailbox, state.selectedFolder);
            await updateSelectedSnapshot();
            for (const record of removed) {
              const sequence = previous.findIndex((item) => item.uid === record.uid) + 1;
              if (sequence > 0) {
                write(`* ${sequence} EXPUNGE\r\n`);
              }
            }
            sendTagged(tag, "OK", "EXPUNGE completed");
            return;
          }
          case "CLOSE":
            if (state.selectedFolder && !state.selectedReadOnly) {
              await this.store.expungeDeleted(state.authenticatedUser.mailbox, state.selectedFolder);
            }
            state.selectedFolder = null;
            state.selectedSnapshot = [];
            state.idleStop?.();
            state.idleStop = null;
            sendTagged(tag, "OK", "CLOSE completed");
            return;
          case "APPEND": {
            const mailboxToken = parseAString(argument);
            let cursor = mailboxToken?.nextIndex ?? 0;
            let flags = [];
            let internalDate = null;
            const tail = argument.slice(cursor).trim();
            if (tail.startsWith("(")) {
              const end = tail.indexOf(")");
              flags = parseFlagList(tail.slice(0, end + 1));
              cursor = argument.indexOf(tail, cursor) + end + 1;
            }
            const afterFlags = argument.slice(cursor).trim();
            if (afterFlags.startsWith('"')) {
              const dateToken = parseAString(argument, cursor);
              internalDate = dateToken?.value ?? null;
            }
            if (!literal) {
              sendTagged(tag, "BAD", "APPEND requires literal message data");
              return;
            }
            await this.store.appendMessage(
              state.authenticatedUser.mailbox,
              mailboxToken?.value ?? "",
              {
                rawMessage: literal.toString("utf8"),
                mailFrom: null,
                rcptTo: [],
                remoteAddress: socket.remoteAddress ?? null,
                flags,
                internalDate: internalDate ? new Date(internalDate).toISOString() : undefined
              }
            );
            sendTagged(tag, "OK", "APPEND completed");
            return;
          }
          case "IDLE":
            if (!state.selectedFolder) {
              sendTagged(tag, "BAD", "No mailbox selected");
              return;
            }
            state.idleTag = tag;
            write("+ idling\r\n");
            return;
          case "UID": {
            const [subcommand, ...rest] = splitTopLevel(argument);
            const upper = (subcommand ?? "").toUpperCase();
            await updateSelectedSnapshot();
            if (upper === "FETCH") {
              await performFetch(tag, rest.shift(), rest.join(" "), true);
              return;
            }
            if (upper === "STORE") {
              await performStore(tag, rest.shift(), rest.shift(), rest.join(" "), true);
              return;
            }
            if (upper === "SEARCH") {
              await searchMessages(tag, rest.join(" "), true);
              return;
            }
            if (upper === "COPY") {
              const sequenceSet = rest.shift();
              const targetFolder = decodeMailboxName(rest.join(" "));
              await this.store.copyMessages(
                state.authenticatedUser.mailbox,
                state.selectedFolder,
                targetFolder,
                resolveMessages(sequenceSet, true).map((item) => item.uid)
              );
              sendTagged(tag, "OK", "UID COPY completed");
              return;
            }
            sendTagged(tag, "BAD", "Unsupported UID command");
            return;
          }
          default:
            sendTagged(tag, "BAD", "Command not implemented");
        }
      } catch (error) {
        this.log.warn("imap.command_failed", {
          remoteAddress: socket.remoteAddress ?? null,
          error: `${error}`,
          line
        });
        sendTagged(tag, "NO", `${error instanceof Error ? error.message : error}`);
      }
    };

    const processBuffer = async () => {
      while (!state.closed) {
        if (state.literalPending?.authPlain) {
          const index = state.buffer.indexOf("\r\n");
          if (index === -1) {
            return;
          }
          const line = state.buffer.subarray(0, index).toString("utf8");
          state.buffer = state.buffer.subarray(index + 2);
          const decoded = Buffer.from(line, "base64").toString("utf8");
          const parts = decoded.split("\u0000");
          const username = parts.length >= 3 ? parts[1] : parts[0];
          const password = parts.length >= 3 ? parts[2] : parts[1];
          const tag = state.literalPending.tag;
          state.literalPending = null;
          const user = await authenticateUser(this.users, username ?? "", password ?? "");
          if (!user) {
            sendTagged(tag, "NO", "Authentication failed");
            continue;
          }
          state.authenticatedUser = user;
          sendTagged(tag, "OK", "AUTHENTICATE completed");
          continue;
        }

        if (state.literalPending?.size) {
          if (state.buffer.length < state.literalPending.size + 2) {
            return;
          }
          const literal = state.buffer.subarray(0, state.literalPending.size);
          state.buffer = state.buffer.subarray(state.literalPending.size + 2);
          const pending = state.literalPending;
          state.literalPending = null;
          await handleCommand(pending.line, literal);
          continue;
        }

        const index = state.buffer.indexOf("\r\n");
        if (index === -1) {
          return;
        }
        const line = state.buffer.subarray(0, index).toString("utf8");
        state.buffer = state.buffer.subarray(index + 2);
        const literalMatch = line.match(/\{(\d+)\}$/);
        if (literalMatch) {
          state.literalPending = {
            line: line.replace(/\{(\d+)\}$/, "").trimEnd(),
            size: Number(literalMatch[1])
          };
          write("+ Ready for literal data\r\n");
          continue;
        }
        await handleCommand(line, null);
      }
    };

    socket.setTimeout(this.config.limits.socketTimeoutMs, () => {
      write("* BYE inactivity timeout\r\n");
      state.closed = true;
      safeSocketEnd(socket);
    });

    this.log.info("imap.connection_opened", {
      secure,
      remoteAddress: socket.remoteAddress ?? null,
      remotePort: socket.remotePort ?? null
    });
    write(`* OK [CAPABILITY ${CAPABILITIES.join(" ")}] ${this.config.server.smtp.hostname} IMAP ready\r\n`);

    socket.on("data", (chunk) => {
      state.buffer = Buffer.concat([state.buffer, Buffer.from(chunk)]);
      void processBuffer().catch((error) => {
        this.log.error("imap.read_failed", { error: `${error}` });
        state.closed = true;
        safeSocketEnd(socket);
      });
    });

    socket.on("error", (error) => {
      this.log.warn("imap.socket_error", { error: `${error}` });
    });

    socket.on("close", () => {
      endIdle(false);
      state.idleStop?.();
      state.closed = true;
      this.log.info("imap.connection_closed", {
        secure,
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
        mailbox: state.authenticatedUser?.mailbox ?? null,
        selectedFolder: state.selectedFolder
      });
    });
  }
}
