import { readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAttachmentMetadata } from "./mime.js";
import { ensureDirectory, ensureParentDirectory, generateMessageId, getHeader, sha256 } from "./util.js";

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

function messagePath(rootDir, mailbox, id) {
  return join(curDir(rootDir, mailbox), `${id}.eml`);
}

function metadataPath(rootDir, mailbox, id) {
  return join(metaDir(rootDir, mailbox), `${id}.json`);
}

export class MailboxStore {
  constructor(config) {
    this.config = config;
  }

  async initialize() {
    await ensureDirectory(this.config.storage.rootDir);
    for (const user of this.config.users) {
      await ensureDirectory(curDir(this.config.storage.rootDir, user.mailbox));
      await ensureDirectory(tmpDir(this.config.storage.rootDir, user.mailbox));
      await ensureDirectory(metaDir(this.config.storage.rootDir, user.mailbox));
    }
  }

  async ensureQuota(mailbox, incomingSize) {
    const messages = await this.listMessages(mailbox);
    const currentSize = messages.reduce((total, item) => total + item.size, 0);
    if (currentSize + incomingSize > this.config.limits.maxMailboxBytes) {
      throw new Error(`Mailbox quota exceeded for ${mailbox}`);
    }
  }

  async deliver(mailbox, request) {
    const rawMessage = request.rawMessage;
    const size = Buffer.byteLength(rawMessage, "utf8");
    await ensureDirectory(curDir(this.config.storage.rootDir, mailbox));
    await ensureDirectory(tmpDir(this.config.storage.rootDir, mailbox));
    await ensureDirectory(metaDir(this.config.storage.rootDir, mailbox));
    await this.ensureQuota(mailbox, size);

    const id = generateMessageId(this.config.server.smtp.hostname);
    const uidl = sha256(`${mailbox}:${id}`);
    const tempPath = join(tmpDir(this.config.storage.rootDir, mailbox), `${id}.eml.tmp`);
    const finalMessagePath = messagePath(this.config.storage.rootDir, mailbox, id);
    const finalMetadataPath = metadataPath(this.config.storage.rootDir, mailbox, id);

    await ensureParentDirectory(tempPath);
    await writeFile(tempPath, rawMessage, "utf8");

    const metadata = {
      id,
      mailbox,
      uidl,
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
        mailFrom: request.mailFrom,
        rcptTo: request.rcptTo,
        remoteAddress: request.remoteAddress
      }
    };

    await writeFile(finalMetadataPath, JSON.stringify(metadata, null, 2), "utf8");
    await rename(tempPath, finalMessagePath);
    return metadata;
  }

  async listMessages(mailbox) {
    const base = metaDir(this.config.storage.rootDir, mailbox);
    await ensureDirectory(base);
    const directory = new Bun.Glob("*.json");
    const messages = [];

    for await (const file of directory.scan({ cwd: base, absolute: true })) {
      const metadata = JSON.parse(await readFile(file, "utf8"));
      messages.push({
        id: metadata.id,
        uidl: metadata.uidl,
        size: metadata.size,
        metadata
      });
    }

    messages.sort((a, b) => a.metadata.receivedAt.localeCompare(b.metadata.receivedAt));
    return messages;
  }

  async getMessage(mailbox, id) {
    return await readFile(messagePath(this.config.storage.rootDir, mailbox, id), "utf8");
  }

  async deleteMessage(mailbox, id) {
    await unlink(messagePath(this.config.storage.rootDir, mailbox, id)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await unlink(metadataPath(this.config.storage.rootDir, mailbox, id)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  async recoverMailbox(mailbox) {
    const glob = new Bun.Glob("*.tmp");
    for await (const file of glob.scan({ cwd: tmpDir(this.config.storage.rootDir, mailbox), absolute: true })) {
      await rm(file, { force: true });
    }
  }

  async recoverAll() {
    for (const user of this.config.users) {
      await this.recoverMailbox(user.mailbox);
    }
  }
}
