import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, expectOk, pop3Command, readUntil, setupServer } from "./helpers.js";

let activeServer = null;

afterEach(async () => {
  if (activeServer) {
    await activeServer.server.stop();
    activeServer = null;
  }
});

describe("PostOfficeX", () => {
  test("receives SMTP mail and retrieves it over POP3", async () => {
    activeServer = await setupServer();

    const smtp = await connect(activeServer.smtpPort);
    expect((await readUntil(smtp, (text) => text.endsWith("\r\n"))).startsWith("220")).toBe(true);
    smtp.write("EHLO localhost\r\n");
    expect((await readUntil(smtp, (text) => text.includes("250 SIZE")))).toContain("250 SIZE");
    smtp.write("MAIL FROM:<sender@external.test>\r\n");
    expect((await readUntil(smtp, (text) => text.endsWith("\r\n")))).toContain("250");
    smtp.write("RCPT TO:<alice@example.test>\r\n");
    expect((await readUntil(smtp, (text) => text.endsWith("\r\n")))).toContain("250");
    smtp.write("DATA\r\n");
    expect((await readUntil(smtp, (text) => text.endsWith("\r\n")))).toContain("354");
    smtp.write("From: Sender <sender@external.test>\r\nTo: alice@example.test\r\nSubject: Hello\r\n\r\nThis is a test.\r\n.\r\n");
    expect((await readUntil(smtp, (text) => text.endsWith("\r\n")))).toContain("250");
    smtp.write("QUIT\r\n");
    smtp.end();

    const pop3 = await connect(activeServer.pop3Port);
    expect((await readUntil(pop3, (text) => text.endsWith("\r\n"))).startsWith("+OK")).toBe(true);
    expectOk(await pop3Command(pop3, "USER alice\r\n"));
    expectOk(await pop3Command(pop3, "PASS secret123\r\n"));
    expect(await pop3Command(pop3, "STAT\r\n")).toContain("+OK 1");
    const retr = await pop3Command(pop3, "RETR 1\r\n", true);
    expect(retr).toContain("Subject: Hello");
    expect(retr).toContain("This is a test.");
    expectOk(await pop3Command(pop3, "QUIT\r\n"));
    pop3.end();
  });

  test("preserves attachment metadata alongside the raw message", async () => {
    activeServer = await setupServer();

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
    smtp.write(
      "From: Sender <sender@external.test>\r\n" +
        "To: alice@example.test\r\n" +
        "Subject: Attachment test\r\n" +
        "Content-Type: multipart/mixed; boundary=\"mix\"\r\n\r\n" +
        "--mix\r\nContent-Type: text/plain\r\n\r\nHello\r\n" +
        "--mix\r\nContent-Type: text/plain; name=\"note.txt\"\r\n" +
        "Content-Disposition: attachment; filename=\"note.txt\"\r\n" +
        "Content-Transfer-Encoding: base64\r\n\r\n" +
        "aGVsbG8gd29ybGQ=\r\n" +
        "--mix--\r\n.\r\n"
    );
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    smtp.end();

    const mailboxDir = join(activeServer.rootDir, "data", "mailboxes", "alice", "meta");
    const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: mailboxDir, absolute: true }));
    expect(files.length).toBe(1);
    const metadata = JSON.parse(await readFile(files[0], "utf8"));
    expect(metadata.attachments).toHaveLength(1);
    expect(metadata.attachments[0].filename).toBe("note.txt");
    expect(metadata.attachments[0].size).toBeGreaterThan(0);
  });

  test("deletes messages only after POP3 QUIT", async () => {
    activeServer = await setupServer();

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
    smtp.write("Subject: Delete test\r\n\r\nbody\r\n.\r\n");
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    smtp.end();

    const pop3a = await connect(activeServer.pop3Port);
    await readUntil(pop3a, (text) => text.endsWith("\r\n"));
    await pop3Command(pop3a, "USER alice\r\n");
    await pop3Command(pop3a, "PASS secret123\r\n");
    expect(await pop3Command(pop3a, "STAT\r\n")).toContain("+OK 1");
    expect(await pop3Command(pop3a, "DELE 1\r\n")).toContain("+OK");
    expect(await pop3Command(pop3a, "RSET\r\n")).toContain("+OK");
    expect(await pop3Command(pop3a, "QUIT\r\n")).toContain("+OK");

    const pop3b = await connect(activeServer.pop3Port);
    await readUntil(pop3b, (text) => text.endsWith("\r\n"));
    await pop3Command(pop3b, "USER alice\r\n");
    await pop3Command(pop3b, "PASS secret123\r\n");
    expect(await pop3Command(pop3b, "STAT\r\n")).toContain("+OK 1");
    expect(await pop3Command(pop3b, "DELE 1\r\n")).toContain("+OK");
    expect(await pop3Command(pop3b, "QUIT\r\n")).toContain("+OK");

    const pop3c = await connect(activeServer.pop3Port);
    await readUntil(pop3c, (text) => text.endsWith("\r\n"));
    await pop3Command(pop3c, "USER alice\r\n");
    await pop3Command(pop3c, "PASS secret123\r\n");
    expect(await pop3Command(pop3c, "STAT\r\n")).toContain("+OK 0");
    expect(await pop3Command(pop3c, "QUIT\r\n")).toContain("+OK");
  });

  test("accepts POP3 login by email address and repeated-domain login", async () => {
    activeServer = await setupServer();

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
    smtp.write("Subject: Address login\r\n\r\nbody\r\n.\r\n");
    await readUntil(smtp, (text) => text.endsWith("\r\n"));
    smtp.end();

    const pop3a = await connect(activeServer.pop3Port);
    await readUntil(pop3a, (text) => text.endsWith("\r\n"));
    expectOk(await pop3Command(pop3a, "USER alice@example.test\r\n"));
    expectOk(await pop3Command(pop3a, "PASS secret123\r\n"));
    expect(await pop3Command(pop3a, "STAT\r\n")).toContain("+OK 1");
    expectOk(await pop3Command(pop3a, "QUIT\r\n"));

    const pop3b = await connect(activeServer.pop3Port);
    await readUntil(pop3b, (text) => text.endsWith("\r\n"));
    expectOk(await pop3Command(pop3b, "USER alice@example.test@example.test\r\n"));
    expectOk(await pop3Command(pop3b, "PASS secret123\r\n"));
    expect(await pop3Command(pop3b, "STAT\r\n")).toContain("+OK 1");
    expectOk(await pop3Command(pop3b, "QUIT\r\n"));
  });
});
