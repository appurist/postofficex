import { EventEmitter } from "node:events";
import { copyFile, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAttachmentMetadata } from "./mime.js";
import { ensureDirectory, ensureParentDirectory, generateMessageId, getHeader, sha256 } from "./util.js";

const INBOX = "INBOX";

function mailboxBase(rootDir, mailbox) {
  return join(rootDir, "mailboxes", mailbox);
}

function curDir(rootDir, mailbox) {
  return join(mailboxBase(rootDir, mailbox), "cur");
}

function tmpDir(rootDir, mailbox) {
  return join(mailboxBase(rootDir, mailbox), "tmp");
}

function metaDir(rootDir, mailbox) {
  return join(mailboxBase(rootDir, mailbox), "meta");
}

function foldersDir(rootDir, mailbox) {
  return join(mailboxBase(rootDir, mailbox), "folders");
}

function messagesMetaDir(rootDir, mailbox) {
  return join(mailboxBase(rootDir, mailbox), "messages");
}

function incomingDir(rootDir) {
  return join(rootDir, "incoming");
}

function folderKey(folder) {
  return encodeURIComponent(folder);
}

function normalizeFolderName(folder) {
  const trimmed = `${folder ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("Mailbox folder name is required");
  }
  return trimmed.toUpperCase() === INBOX ? INBOX : trimmed;
}

function folderBase(rootDir, mailbox, folder) {
  const normalized = normalizeFolderName(folder);
  if (normalized === INBOX) {
    return metaDir(rootDir, mailbox);
  }
  return join(foldersDir(rootDir, mailbox), folderKey(normalized));
}

function folderStatePath(rootDir, mailbox, folder) {
  const normalized = normalizeFolderName(folder);
  if (normalized === INBOX) {
    return join(metaDir(rootDir, mailbox), ".folder.json");
  }
  return join(folderBase(rootDir, mailbox, normalized), "folder.json");
}

function folderRecordsDir(rootDir, mailbox, folder) {
  const normalized = normalizeFolderName(folder);
  if (normalized === INBOX) {
    return metaDir(rootDir, mailbox);
  }
  return join(folderBase(rootDir, mailbox, normalized), "meta");
}

function folderRecordPath(rootDir, mailbox, folder, uid) {
  return join(folderRecordsDir(rootDir, mailbox, folder), `${uid}.json`);
}

function messagePath(rootDir, mailbox, messageId) {
  return join(curDir(rootDir, mailbox), `${messageId}.eml`);
}

function messageMetadataPath(rootDir, mailbox, messageId) {
  return join(messagesMetaDir(rootDir, mailbox), `${messageId}.json`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await ensureParentDirectory(path);
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function createUidValidity() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

function formatInternalDate(value) {
  return new Date(value).toISOString();
}

export class MailboxStore {
  constructor(config) {
    this.config = config;
    this.events = new EventEmitter();
  }

  async initialize() {
    await ensureDirectory(this.config.storage.rootDir);
    await ensureDirectory(incomingDir(this.config.storage.rootDir));
    for (const user of this.config.users) {
      await this.ensureMailboxStructure(user.mailbox);
      await this.ensureFolder(user.mailbox, INBOX, { subscribe: true });
    }
  }

  async ensureMailboxStructure(mailbox) {
    await ensureDirectory(curDir(this.config.storage.rootDir, mailbox));
    await ensureDirectory(tmpDir(this.config.storage.rootDir, mailbox));
    await ensureDirectory(metaDir(this.config.storage.rootDir, mailbox));
    await ensureDirectory(foldersDir(this.config.storage.rootDir, mailbox));
    await ensureDirectory(messagesMetaDir(this.config.storage.rootDir, mailbox));
  }

  async ensureQuota(mailbox, incomingSize) {
    await this.ensureMailboxStructure(mailbox);
    const blobs = new Bun.Glob("*.eml");
    let currentSize = 0;

    for await (const file of blobs.scan({ cwd: curDir(this.config.storage.rootDir, mailbox), absolute: true })) {
      currentSize += await Bun.file(file).size;
    }

    if (currentSize + incomingSize > this.config.limits.maxMailboxBytes) {
      throw new Error(`Mailbox quota exceeded for ${mailbox}`);
    }
  }

  buildMessageMetadata(mailbox, rawMessage, size, request) {
    const messageId = generateMessageId(this.config.server.smtp.hostname);
    return {
      messageId,
      mailbox,
      size,
      from: getHeader(rawMessage, "from"),
      to: (getHeader(rawMessage, "to") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      subject: getHeader(rawMessage, "subject"),
      receivedAt: new Date().toISOString(),
      attachments: extractAttachmentMetadata(rawMessage),
      envelope: {
        mailFrom: request.mailFrom ?? null,
        rcptTo: request.rcptTo ?? [],
        remoteAddress: request.remoteAddress ?? null
      }
    };
  }

  buildFolderRecord(folder, uid, message, options = {}) {
    const internalDate = formatInternalDate(options.internalDate ?? message.receivedAt ?? new Date().toISOString());
    const flags = Array.from(new Set((options.flags ?? []).map((flag) => flag.trim()).filter(Boolean))).sort();
    return {
      uid,
      messageId: message.messageId,
      folder,
      uidl: sha256(`${message.mailbox}:${folder}:${uid}:${message.messageId}`),
      size: message.size,
      from: message.from,
      to: message.to,
      subject: message.subject,
      receivedAt: message.receivedAt,
      internalDate,
      recent: options.recent ?? true,
      flags,
      attachments: message.attachments,
      envelope: message.envelope
    };
  }

  async ensureFolder(mailbox, folder, options = {}) {
    const normalized = normalizeFolderName(folder);
    await this.ensureMailboxStructure(mailbox);
    const statePath = folderStatePath(this.config.storage.rootDir, mailbox, normalized);
    await ensureDirectory(folderRecordsDir(this.config.storage.rootDir, mailbox, normalized));

    try {
      return await readJson(statePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const state = {
      name: normalized,
      uidValidity: createUidValidity(),
      uidNext: 1,
      subscribed: options.subscribe ?? normalized === INBOX
    };
    await writeJson(statePath, state);
    return state;
  }

  async getFolder(mailbox, folder) {
    return await this.ensureFolder(mailbox, folder);
  }

  async writeFolder(mailbox, folder, state) {
    await writeJson(folderStatePath(this.config.storage.rootDir, mailbox, folder), state);
  }

  async listFolders(mailbox) {
    await this.ensureMailboxStructure(mailbox);
    const folders = [await this.ensureFolder(mailbox, INBOX, { subscribe: true })];
    const glob = new Bun.Glob("*/folder.json");

    for await (const file of glob.scan({ cwd: foldersDir(this.config.storage.rootDir, mailbox), absolute: true })) {
      folders.push(await readJson(file));
    }

    folders.sort((a, b) => {
      if (a.name === INBOX) {
        return -1;
      }
      if (b.name === INBOX) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
    return folders;
  }

  async createFolder(mailbox, folder) {
    const normalized = normalizeFolderName(folder);
    const existing = await this.listFolders(mailbox);
    if (existing.some((item) => item.name === normalized)) {
      throw new Error(`Mailbox folder already exists: ${normalized}`);
    }
    return await this.ensureFolder(mailbox, normalized);
  }

  async deleteFolder(mailbox, folder) {
    const normalized = normalizeFolderName(folder);
    if (normalized === INBOX) {
      throw new Error("INBOX cannot be deleted");
    }

    const folders = await this.listFolders(mailbox);
    if (folders.some((item) => item.name.startsWith(`${normalized}/`))) {
      throw new Error("Mailbox folder has child folders");
    }

    const messages = await this.listFolderMessages(mailbox, normalized);
    if (messages.length > 0) {
      throw new Error("Mailbox folder is not empty");
    }

    await rm(folderBase(this.config.storage.rootDir, mailbox, normalized), { recursive: true, force: true });
    this.publishMailboxChange(mailbox, normalized, { type: "folder-delete", folder: normalized });
  }

  async renameFolder(mailbox, fromFolder, toFolder) {
    const fromName = normalizeFolderName(fromFolder);
    const toName = normalizeFolderName(toFolder);
    if (fromName === INBOX) {
      throw new Error("INBOX cannot be renamed");
    }

    const folders = await this.listFolders(mailbox);
    const matches = folders.filter((item) => item.name === fromName || item.name.startsWith(`${fromName}/`));
    if (matches.length === 0) {
      throw new Error(`Mailbox folder not found: ${fromName}`);
    }

    for (const folder of matches.sort((a, b) => b.name.length - a.name.length)) {
      const nextName = folder.name === fromName ? toName : `${toName}${folder.name.slice(fromName.length)}`;
      const refreshedFolders = await this.listFolders(mailbox);
      const targetExists = refreshedFolders.some((item) => item.name === nextName);
      const currentBase = folderBase(this.config.storage.rootDir, mailbox, folder.name);
      const nextBase = folderBase(this.config.storage.rootDir, mailbox, nextName);

      if (targetExists) {
        await this.mergeFolderMessages(mailbox, folder.name, nextName);
        await rm(currentBase, { recursive: true, force: true });
        this.publishMailboxChange(mailbox, folder.name, { type: "folder-delete", folder: folder.name });
        continue;
      }

      await ensureParentDirectory(nextBase);
      await rename(currentBase, nextBase);
      await this.writeFolder(mailbox, nextName, { ...folder, name: nextName });
      this.publishMailboxChange(mailbox, folder.name, { type: "folder-rename", from: folder.name, to: nextName });
      this.publishMailboxChange(mailbox, nextName, { type: "folder-rename", from: folder.name, to: nextName });
    }
  }

  async appendFolderRecord(mailbox, folder, record) {
    const targetFolder = await this.ensureFolder(mailbox, folder);
    const uid = targetFolder.uidNext;
    targetFolder.uidNext += 1;
    await this.writeFolder(mailbox, targetFolder.name, targetFolder);

    const nextRecord = {
      ...record,
      uid,
      folder: targetFolder.name,
      uidl: sha256(`${mailbox}:${targetFolder.name}:${uid}:${record.messageId}`)
    };
    await writeJson(folderRecordPath(this.config.storage.rootDir, mailbox, targetFolder.name, uid), nextRecord);
    return nextRecord;
  }

  async mergeFolderMessages(mailbox, sourceFolder, targetFolder) {
    const sourceName = normalizeFolderName(sourceFolder);
    const targetName = normalizeFolderName(targetFolder);
    const messages = await this.listFolderMessages(mailbox, sourceName);
    const targetMessages = await this.listFolderMessages(mailbox, targetName);
    const targetMessageIds = new Set(targetMessages.map((item) => item.messageId));
    const merged = [];

    for (const record of messages) {
      if (!targetMessageIds.has(record.messageId)) {
        const nextRecord = await this.appendFolderRecord(mailbox, targetName, record);
        targetMessageIds.add(record.messageId);
        merged.push(nextRecord);
      }
      await unlink(folderRecordPath(this.config.storage.rootDir, mailbox, sourceName, record.uid)).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }

    if (merged.length > 0) {
      const exists = (await this.listFolderMessages(mailbox, targetName)).length;
      this.publishMailboxChange(mailbox, targetName, {
        type: "append",
        folder: targetName,
        uid: merged.at(-1)?.uid,
        exists
      });
    }

    return merged;
  }

  async setFolderSubscription(mailbox, folder, subscribed) {
    const state = await this.ensureFolder(mailbox, folder);
    state.subscribed = subscribed;
    await this.writeFolder(mailbox, state.name, state);
    return state;
  }

  async storeMessageBlob(mailbox, rawMessage, request) {
    const size = Buffer.byteLength(rawMessage, "utf8");
    await this.ensureQuota(mailbox, size);
    const message = this.buildMessageMetadata(mailbox, rawMessage, size, request);
    const tempPath = join(tmpDir(this.config.storage.rootDir, mailbox), `${message.messageId}.eml.tmp`);

    await ensureParentDirectory(tempPath);
    await writeFile(tempPath, rawMessage, "utf8");
    await writeJson(messageMetadataPath(this.config.storage.rootDir, mailbox, message.messageId), message);
    await rename(tempPath, messagePath(this.config.storage.rootDir, mailbox, message.messageId));
    return message;
  }

  async storeMessageBlobFromFile(mailbox, request) {
    const size = request.size ?? (await Bun.file(request.filePath).size);
    await this.ensureQuota(mailbox, size);
    const rawMessage = await readFile(request.filePath, "utf8");
    const message = this.buildMessageMetadata(mailbox, rawMessage, size, request);
    const tempPath = join(tmpDir(this.config.storage.rootDir, mailbox), `${message.messageId}.eml.tmp`);

    await ensureParentDirectory(tempPath);
    await copyFile(request.filePath, tempPath);
    await writeJson(messageMetadataPath(this.config.storage.rootDir, mailbox, message.messageId), message);
    await rename(tempPath, messagePath(this.config.storage.rootDir, mailbox, message.messageId));
    return message;
  }

  async appendStoredMessage(mailbox, folder, message, options = {}) {
    const targetFolder = await this.ensureFolder(mailbox, folder);
    const uid = targetFolder.uidNext;
    targetFolder.uidNext += 1;
    await this.writeFolder(mailbox, targetFolder.name, targetFolder);

    const record = this.buildFolderRecord(targetFolder.name, uid, message, options);
    await writeJson(folderRecordPath(this.config.storage.rootDir, mailbox, targetFolder.name, uid), record);
    const exists = (await this.listFolderMessages(mailbox, targetFolder.name)).length;
    this.publishMailboxChange(mailbox, targetFolder.name, {
      type: "append",
      folder: targetFolder.name,
      uid,
      exists
    });
    return { ...record, uidNext: targetFolder.uidNext, uidValidity: targetFolder.uidValidity };
  }

  async appendMessage(mailbox, folder, request) {
    const message = await this.storeMessageBlob(mailbox, request.rawMessage, request);
    return await this.appendStoredMessage(mailbox, folder, message, request);
  }

  async appendMessageFromFile(mailbox, folder, request) {
    const message = await this.storeMessageBlobFromFile(mailbox, request);
    return await this.appendStoredMessage(mailbox, folder, message, request);
  }

  async deliver(mailbox, request) {
    return await this.appendMessage(mailbox, INBOX, request);
  }

  async deliverFromFile(mailbox, request) {
    return await this.appendMessageFromFile(mailbox, INBOX, request);
  }

  async listFolderMessages(mailbox, folder) {
    const state = await this.ensureFolder(mailbox, folder);
    const base = folderRecordsDir(this.config.storage.rootDir, mailbox, state.name);
    const directory = new Bun.Glob("*.json");
    const messages = [];

    for await (const file of directory.scan({ cwd: base, absolute: true })) {
      const metadata = JSON.parse(await readFile(file, "utf8"));
      if (!Number.isFinite(metadata?.uid)) {
        continue;
      }
      messages.push(metadata);
    }

    messages.sort((a, b) => a.uid - b.uid);
    return messages;
  }

  async getFolderMessage(mailbox, folder, uid) {
    const normalized = normalizeFolderName(folder);
    return await readJson(folderRecordPath(this.config.storage.rootDir, mailbox, normalized, uid));
  }

  async getMessageBlob(mailbox, messageId) {
    return await readFile(messagePath(this.config.storage.rootDir, mailbox, messageId), "utf8");
  }

  async getFolderMessageBody(mailbox, folder, uid) {
    const record = await this.getFolderMessage(mailbox, folder, uid);
    return await this.getMessageBlob(mailbox, record.messageId);
  }

  async updateMessageFlags(mailbox, folder, uids, mode, flags) {
    const normalized = normalizeFolderName(folder);
    const targetFlags = Array.from(new Set(flags.map((flag) => flag.trim()).filter(Boolean))).sort();
    const changed = [];

    for (const uid of uids) {
      const record = await this.getFolderMessage(mailbox, normalized, uid).catch((error) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (!record) {
        continue;
      }

      const current = new Set(record.flags ?? []);
      if (mode === "set") {
        current.clear();
        targetFlags.forEach((flag) => current.add(flag));
      } else if (mode === "add") {
        targetFlags.forEach((flag) => current.add(flag));
      } else if (mode === "remove") {
        targetFlags.forEach((flag) => current.delete(flag));
      }

      record.flags = Array.from(current).sort();
      if (record.flags.includes("\\Seen")) {
        record.recent = false;
      }
      await writeJson(folderRecordPath(this.config.storage.rootDir, mailbox, normalized, uid), record);
      changed.push(record);
      this.publishMailboxChange(mailbox, normalized, {
        type: "flags",
        folder: normalized,
        uid,
        flags: record.flags
      });
    }

    return changed;
  }

  async clearRecent(mailbox, folder) {
    const normalized = normalizeFolderName(folder);
    const messages = await this.listFolderMessages(mailbox, normalized);
    for (const message of messages.filter((item) => item.recent)) {
      message.recent = false;
      await writeJson(folderRecordPath(this.config.storage.rootDir, mailbox, normalized, message.uid), message);
    }
  }

  async copyMessages(mailbox, sourceFolder, targetFolder, uids) {
    const sourceName = normalizeFolderName(sourceFolder);
    const copied = [];
    for (const uid of uids) {
      const record = await this.getFolderMessage(mailbox, sourceName, uid).catch((error) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (!record) {
        continue;
      }
      const message = await readJson(messageMetadataPath(this.config.storage.rootDir, mailbox, record.messageId));
      copied.push(
        await this.appendStoredMessage(mailbox, targetFolder, message, {
          flags: record.flags,
          internalDate: record.internalDate,
          recent: true
        })
      );
    }
    return copied;
  }

  async expungeDeleted(mailbox, folder) {
    const normalized = normalizeFolderName(folder);
    const messages = await this.listFolderMessages(mailbox, normalized);
    const deleted = messages.filter((item) => (item.flags ?? []).includes("\\Deleted"));
    const removed = [];

    for (const record of deleted) {
      await unlink(folderRecordPath(this.config.storage.rootDir, mailbox, normalized, record.uid)).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      await this.cleanupMessageBlob(mailbox, record.messageId);
      removed.push(record);
    }

    if (removed.length > 0) {
      const exists = (await this.listFolderMessages(mailbox, normalized)).length;
      this.publishMailboxChange(mailbox, normalized, {
        type: "expunge",
        folder: normalized,
        removedUids: removed.map((item) => item.uid),
        exists
      });
    }

    return removed;
  }

  async cleanupMessageBlob(mailbox, messageId) {
    if (await this.messageHasReferences(mailbox, messageId)) {
      return;
    }

    await unlink(messagePath(this.config.storage.rootDir, mailbox, messageId)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await unlink(messageMetadataPath(this.config.storage.rootDir, mailbox, messageId)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  async messageHasReferences(mailbox, messageId) {
    const folders = await this.listFolders(mailbox);
    for (const folder of folders) {
      const messages = await this.listFolderMessages(mailbox, folder.name);
      if (messages.some((item) => item.messageId === messageId)) {
        return true;
      }
    }
    return false;
  }

  async getFolderStatus(mailbox, folder) {
    const state = await this.ensureFolder(mailbox, folder);
    const messages = await this.listFolderMessages(mailbox, state.name);
    return {
      name: state.name,
      uidValidity: state.uidValidity,
      uidNext: state.uidNext,
      messages,
      exists: messages.length,
      recent: messages.filter((item) => item.recent).length,
      unseen: messages.filter((item) => !(item.flags ?? []).includes("\\Seen")).length
    };
  }

  async listMessages(mailbox) {
    const items = await this.listFolderMessages(mailbox, INBOX);
    return items.map((item) => ({
      id: `${item.uid}`,
      uidl: item.uidl,
      size: item.size,
      metadata: item
    }));
  }

  async getMessage(mailbox, id) {
    return await this.getFolderMessageBody(mailbox, INBOX, Number(id));
  }

  async deleteMessage(mailbox, id) {
    const uid = Number(id);
    const record = await this.getFolderMessage(mailbox, INBOX, uid).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!record) {
      return;
    }
    await unlink(folderRecordPath(this.config.storage.rootDir, mailbox, INBOX, uid)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await this.cleanupMessageBlob(mailbox, record.messageId);
    const exists = (await this.listFolderMessages(mailbox, INBOX)).length;
    this.publishMailboxChange(mailbox, INBOX, { type: "expunge", folder: INBOX, removedUids: [uid], exists });
  }

  async recoverMailbox(mailbox) {
    const glob = new Bun.Glob("*.tmp");
    for await (const file of glob.scan({ cwd: tmpDir(this.config.storage.rootDir, mailbox), absolute: true })) {
      await rm(file, { force: true });
    }
  }

  async recoverAll() {
    const incoming = new Bun.Glob("*.tmp");
    for await (const file of incoming.scan({ cwd: incomingDir(this.config.storage.rootDir), absolute: true })) {
      await rm(file, { force: true });
    }

    for (const user of this.config.users) {
      await this.recoverMailbox(user.mailbox);
      await this.ensureFolder(user.mailbox, INBOX, { subscribe: true });
    }
  }

  subscribeToFolder(mailbox, folder, listener) {
    const key = `${mailbox}:${normalizeFolderName(folder)}`;
    this.events.on(key, listener);
    return () => {
      this.events.off(key, listener);
    };
  }

  publishMailboxChange(mailbox, folder, event) {
    const key = `${mailbox}:${normalizeFolderName(folder)}`;
    this.events.emit(key, {
      mailbox,
      folder: normalizeFolderName(folder),
      ...event
    });
  }
}
