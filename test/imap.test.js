import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { PostOfficeServer } from "../src/server.js";
import { MailboxStore } from "../src/storage.js";
import { connect, connectTls, pop3Command, readUntil, setupServer } from "./helpers.js";

let activeServer = null;
let tagCounter = 1;

afterEach(async () => {
  if (activeServer) {
    await activeServer.server.stop();
    activeServer = null;
  }
  tagCounter = 1;
});

function nextTag() {
  return `A${tagCounter++}`;
}

async function openImap() {
  const socket = await connectTls(activeServer.imapTlsPort);
  const greeting = await readUntil(socket, (text) => text.endsWith("\r\n"));
  expect(greeting).toContain("* OK");
  return socket;
}

async function imapTagged(socket, command, predicate) {
  const tag = nextTag();
  socket.write(`${tag} ${command}\r\n`);
  const response = await readUntil(socket, predicate ?? ((text) => text.includes(`\r\n${tag} `) || text.startsWith(`${tag} `)));
  return { tag, response };
}

async function imapLogin(socket) {
  const { response } = await imapTagged(socket, 'LOGIN "alice" "secret123"');
  expect(response).toContain("OK LOGIN completed");
}

async function deliverInbound(subject, body = "body") {
  const smtp = await connect(activeServer.smtpPort);
  await readUntil(smtp, (text) => text.endsWith("\r\n"));
  smtp.write("EHLO localhost\r\n");
  await readUntil(smtp, (text) => text.includes("250 SIZE"));
  smtp.write("MAIL FROM:<sender@external.test>\r\n");
  await readUntil(smtp, (text) => text.endsWith("\r\n"));
  smtp.write("RCPT TO:<alice@example.test>\r\n");
  await readUntil(smtp, (text) => text.endsWith("\r\n"));
  smtp.write("DATA\r\n");
  await readUntil(smtp, (text) => text.endsWith("\r\n"));
  smtp.write(`From: Sender <sender@external.test>\r\nTo: alice@example.test\r\nSubject: ${subject}\r\n\r\n${body}\r\n.\r\n`);
  await readUntil(smtp, (text) => text.endsWith("\r\n"));
  smtp.end();
}

async function restartServer() {
  const config = await loadConfig(activeServer.configPath);
  await activeServer.server.stop();
  activeServer = {
    ...activeServer,
    server: new PostOfficeServer(config, new MailboxStore(config))
  };
  await activeServer.server.start();
}

describe("imap", () => {
  test("logs in over implicit TLS and lists/selects inbox mail", async () => {
    activeServer = await setupServer();
    await deliverInbound("Hello IMAP", "imap body");

    const imap = await openImap();
    await imapLogin(imap);

    const list = await imapTagged(imap, 'LIST "" "*"');
    expect(list.response).toContain('LIST (\\HasNoChildren) "/" "INBOX"');

    const select = await imapTagged(imap, "SELECT INBOX");
    expect(select.response).toContain("* 1 EXISTS");
    expect(select.response).toContain("UIDVALIDITY");

    const fetch = await imapTagged(imap, "FETCH 1 (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])");
    expect(fetch.response).toContain("Subject: Hello IMAP");
    expect(fetch.response).toContain("UID 1");
    expect(fetch.response).toContain("FLAGS ()");

    const logout = await imapTagged(imap, "LOGOUT");
    expect(logout.response).toContain("* BYE");
  });

  test("persists folder state, uid fetch values, and flags across restart", async () => {
    activeServer = await setupServer();
    await deliverInbound("Persisted");

    const imap = await openImap();
    await imapLogin(imap);
    await imapTagged(imap, 'CREATE "Archive"');
    await imapTagged(imap, "SELECT INBOX");
    const uidFetch = await imapTagged(imap, "UID FETCH 1:* (UID FLAGS)");
    expect(uidFetch.response).toContain("UID 1");
    await imapTagged(imap, "UID STORE 1 +FLAGS (\\Seen \\Flagged)");
    await imapTagged(imap, "UID COPY 1 Archive");
    await imapTagged(imap, "LOGOUT");

    await restartServer();

    const imapAfter = await openImap();
    await imapLogin(imapAfter);
    const list = await imapTagged(imapAfter, 'LIST "" "*"');
    expect(list.response).toContain('"Archive"');

    await imapTagged(imapAfter, "SELECT INBOX");
    const fetchInbox = await imapTagged(imapAfter, "UID FETCH 1:* (UID FLAGS)");
    expect(fetchInbox.response).toContain("UID 1");
    expect(fetchInbox.response).toContain("\\Seen");
    expect(fetchInbox.response).toContain("\\Flagged");

    const status = await imapTagged(imapAfter, "STATUS Archive (MESSAGES UIDNEXT UIDVALIDITY)");
    expect(status.response).toContain("MESSAGES 1");
    expect(status.response).toContain("UIDNEXT 2");
  });

  test("supports Outlook-style UID FETCH message summaries", async () => {
    activeServer = await setupServer();
    await deliverInbound("Outlook summary", "message preview body");

    const imap = await openImap();
    await imapLogin(imap);
    await imapTagged(imap, "SELECT INBOX");

    const summary = await imapTagged(
      imap,
      "UID FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (From To Subject Date Message-ID)]<0.2048>)"
    );
    expect(summary.response).toContain("UID 1");
    expect(summary.response).toContain("BODYSTRUCTURE");
    expect(summary.response).toContain('ENVELOPE (');
    expect(summary.response).toContain('(("Sender" NIL "sender" "external.test"))');
    expect(summary.response).toContain("Subject: Outlook summary");
    expect(summary.response).toContain("OK FETCH completed");

    const withoutFields = await imapTagged(imap, "UID FETCH 1 (BODY.PEEK[HEADER.FIELDS.NOT (Subject)]<0.2048>)");
    expect(withoutFields.response).toContain("OK FETCH completed");
    expect(withoutFields.response).not.toContain("Subject: Outlook summary");

    const body = await imapTagged(imap, "UID FETCH 1 (BODY.PEEK[]<0.4096>)");
    expect(body.response).toContain("message preview body");

    await imapTagged(imap, "LOGOUT");
  });

  test("supports folder changes, append, copy, search, store, expunge, and POP3 coexistence", async () => {
    activeServer = await setupServer();
    await deliverInbound("Searchable", "first body");

    const imap = await openImap();
    await imapLogin(imap);
    await imapTagged(imap, 'CREATE "Drafts"');
    await imapTagged(imap, 'RENAME "Drafts" "Sent"');
    await imapTagged(imap, 'CREATE "Temp"');
    const deleteTemp = await imapTagged(imap, 'DELETE "Temp"');
    expect(deleteTemp.response).toContain("OK DELETE completed");
    await imapTagged(imap, "SELECT INBOX");

    const searchAll = await imapTagged(imap, "SEARCH ALL");
    expect(searchAll.response).toContain("* SEARCH 1");
    const searchHeader = await imapTagged(imap, 'SEARCH HEADER Subject "Searchable"');
    expect(searchHeader.response).toContain("* SEARCH 1");

    const appended = "From: alice@example.test\r\nTo: alice@example.test\r\nSubject: Uploaded\r\n\r\nsaved copy\r\n";
    const appendTag = nextTag();
    imap.write(`${appendTag} APPEND "Sent" (\\Seen \\Draft) {${Buffer.byteLength(appended, "utf8")}}\r\n`);
    const continuation = await readUntil(imap, (text) => text.endsWith("\r\n"));
    expect(continuation).toContain("+ Ready for literal data");
    imap.write(`${appended}\r\n`);
    const appendDone = await readUntil(imap, (text) => text.includes(`${appendTag} OK`));
    expect(appendDone).toContain("APPEND completed");

    await imapTagged(imap, "UID COPY 1 Sent");
    const sentStatus = await imapTagged(imap, "STATUS Sent (MESSAGES UIDNEXT)");
    expect(sentStatus.response).toContain("MESSAGES 2");

    const store = await imapTagged(imap, "UID STORE 1 +FLAGS (\\Deleted)");
    expect(store.response).toContain("\\Deleted");
    const expunge = await imapTagged(imap, "EXPUNGE");
    expect(expunge.response).toContain("EXPUNGE");

    const pop3 = await connect(activeServer.pop3Port);
    await readUntil(pop3, (text) => text.endsWith("\r\n"));
    expect(await pop3Command(pop3, "USER alice\r\n")).toContain("+OK");
    expect(await pop3Command(pop3, "PASS secret123\r\n")).toContain("+OK");
    expect(await pop3Command(pop3, "STAT\r\n")).toContain("+OK 0");
    expect(await pop3Command(pop3, "QUIT\r\n")).toContain("+OK");

    const sent = await imapTagged(imap, "SELECT Sent");
    expect(sent.response).toContain("* 2 EXISTS");
    const fetchSent = await imapTagged(imap, "FETCH 1:* (UID FLAGS BODY.PEEK[HEADER])");
    expect(fetchSent.response).toContain("Subject: Uploaded");
    expect(fetchSent.response).toContain("\\Draft");

    await imapTagged(imap, "UID STORE 1:* +FLAGS (\\Deleted)");
    const list = await imapTagged(imap, 'LIST "" "*"');
    expect(list.response).not.toContain('"Temp"');
  });

  test("filters listed folders when moving nested folders back to the top level", async () => {
    activeServer = await setupServer();

    const imap = await openImap();
    await imapLogin(imap);
    await imapTagged(imap, 'CREATE "Spam"');
    await imapTagged(imap, 'CREATE "My Stuff"');
    await imapTagged(imap, 'RENAME "My Stuff" "Spam/My Stuff"');

    const exactTopLevel = await imapTagged(imap, 'LIST "" "My Stuff"');
    expect(exactTopLevel.response).not.toContain('"My Stuff"');
    expect(exactTopLevel.response).not.toContain('"Spam/My Stuff"');

    const moveBack = await imapTagged(imap, 'RENAME "Spam/My Stuff" "My Stuff"');
    expect(moveBack.response).toContain("OK RENAME completed");

    const allFolders = await imapTagged(imap, 'LIST "" "*"');
    expect(allFolders.response).toContain('"My Stuff"');
    expect(allFolders.response).not.toContain('"Spam/My Stuff"');

    await imapTagged(imap, "LOGOUT");
  });

  test("merges messages when a stale nested folder is renamed over an existing folder", async () => {
    activeServer = await setupServer();

    const sourceMessage = await activeServer.server.store.appendMessage("alice", "Trash/My Stuff", {
      rawMessage: "From: one@example.test\r\nTo: alice@example.test\r\nSubject: Source copy\r\n\r\nsource\r\n",
      mailFrom: "one@example.test",
      rcptTo: ["alice@example.test"],
      remoteAddress: "127.0.0.1"
    });
    await activeServer.server.store.appendStoredMessage("alice", "My Stuff", sourceMessage, {
      flags: sourceMessage.flags,
      internalDate: sourceMessage.internalDate,
      recent: false
    });
    await activeServer.server.store.appendMessage("alice", "Trash/My Stuff", {
      rawMessage: "From: two@example.test\r\nTo: alice@example.test\r\nSubject: Source only\r\n\r\nsource only\r\n",
      mailFrom: "two@example.test",
      rcptTo: ["alice@example.test"],
      remoteAddress: "127.0.0.1"
    });
    await activeServer.server.store.appendMessage("alice", "My Stuff", {
      rawMessage: "From: three@example.test\r\nTo: alice@example.test\r\nSubject: Target only\r\n\r\ntarget only\r\n",
      mailFrom: "three@example.test",
      rcptTo: ["alice@example.test"],
      remoteAddress: "127.0.0.1"
    });

    const imap = await openImap();
    await imapLogin(imap);
    const moveBack = await imapTagged(imap, 'RENAME "Trash/My Stuff" "My Stuff"');
    expect(moveBack.response).toContain("OK RENAME completed");

    const list = await imapTagged(imap, 'LIST "" "*"');
    expect(list.response).toContain('"My Stuff"');
    expect(list.response).not.toContain('"Trash/My Stuff"');

    const status = await imapTagged(imap, 'STATUS "My Stuff" (MESSAGES)');
    expect(status.response).toContain("MESSAGES 3");

    await imapTagged(imap, 'SELECT "My Stuff"');
    const fetch = await imapTagged(imap, "FETCH 1:* (BODY.PEEK[HEADER])");
    expect(fetch.response).toContain("Subject: Source copy");
    expect(fetch.response).toContain("Subject: Source only");
    expect(fetch.response).toContain("Subject: Target only");

    await imapTagged(imap, "LOGOUT");
  });

  test("delivers IDLE updates for smtp delivery, flag changes, and append from another session", async () => {
    activeServer = await setupServer();

    const watcher = await openImap();
    await imapLogin(watcher);
    await imapTagged(watcher, "SELECT INBOX");

    const idleTag = nextTag();
    watcher.write(`${idleTag} IDLE\r\n`);
    const idleReady = await readUntil(watcher, (text) => text.endsWith("\r\n"));
    expect(idleReady).toContain("+ idling");

    await deliverInbound("Idle inbound");
    const existsUpdate = await readUntil(watcher, (text) => text.includes("EXISTS"));
    expect(existsUpdate).toContain("* 1 EXISTS");

    const actor = await openImap();
    await imapLogin(actor);
    await imapTagged(actor, "SELECT INBOX");
    await imapTagged(actor, "UID STORE 1 +FLAGS (\\Seen)");
    const flagsUpdate = await readUntil(watcher, (text) => text.includes("FETCH (FLAGS"));
    expect(flagsUpdate).toContain("\\Seen");

    const raw = "From: alice@example.test\r\nTo: alice@example.test\r\nSubject: Idle append\r\n\r\ncopy\r\n";
    const appendTag = nextTag();
    actor.write(`${appendTag} APPEND INBOX {${Buffer.byteLength(raw, "utf8")}}\r\n`);
    await readUntil(actor, (text) => text.endsWith("\r\n"));
    actor.write(`${raw}\r\n`);
    await readUntil(actor, (text) => text.includes(`${appendTag} OK`));

    const appendUpdate = await readUntil(watcher, (text) => text.includes("* 2 EXISTS"));
    expect(appendUpdate).toContain("* 2 EXISTS");

    watcher.write("DONE\r\n");
    const done = await readUntil(watcher, (text) => text.includes(`${idleTag} OK`));
    expect(done).toContain("IDLE terminated");
  }, 20000);
});
