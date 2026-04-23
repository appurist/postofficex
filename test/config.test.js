import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

describe("config", () => {
  test("loads defaults, local overrides, and preserves one mailbox with multiple addresses", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "postofficex-config-"));
    const defaultsPath = join(rootDir, "defaults.json");
    const localPath = join(rootDir, "local.json");
    const usersPath = join(rootDir, "users.json");

    await writeJson(defaultsPath, {
      server: {
        smtp: { host: "127.0.0.1", port: 25 }
      },
      tls: {
        certFile: "./certs/server.crt",
        keyFile: "./certs/server.key"
      },
      storage: {
        rootDir: "./data"
      }
    });
    await writeJson(localPath, {
      hostname: "mail.example.test",
      domains: ["example.test"]
    });
    await writeJson(usersPath, [
      {
        username: "alice",
        mailbox: "shared",
        passwordHash: "$argon2id$demo",
        addresses: ["alice@example.test", "support@example.test"]
      }
    ]);

    const config = await loadConfig(localPath);

    expect(config.sources.mode).toBe("layered");
    expect(config.hostname).toBe("mail.example.test");
    expect(config.server.smtp.hostname).toBe("mail.example.test");
    expect(config.outbound.greetingHostname).toBe("mail.example.test");
    expect(config.domains).toEqual(["example.test"]);
    expect(config.users).toHaveLength(1);
    expect(config.users[0].mailbox).toBe("shared");
    expect(config.users[0].addresses).toEqual(["alice@example.test", "support@example.test"]);
  });

  test("allows a specific smtp hostname override while using the global hostname elsewhere", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "postofficex-config-"));
    const defaultsPath = join(rootDir, "defaults.json");
    const localPath = join(rootDir, "local.json");
    const usersPath = join(rootDir, "users.json");

    await writeJson(defaultsPath, {
      outbound: {
        connectTimeoutMs: 30000,
        preferStartTls: true
      }
    });
    await writeJson(localPath, {
      hostname: "mail.example.test",
      domains: ["example.test"],
      server: {
        smtp: {
          hostname: "mx.example.test"
        }
      }
    });
    await writeJson(usersPath, [
      {
        username: "alice",
        mailbox: "alice",
        passwordHash: "$argon2id$demo",
        addresses: ["alice@example.test"]
      }
    ]);

    const config = await loadConfig(localPath);

    expect(config.hostname).toBe("mail.example.test");
    expect(config.server.smtp.hostname).toBe("mx.example.test");
    expect(config.outbound.greetingHostname).toBe("mx.example.test");
  });

  test("saves local overrides and users without rewriting defaults", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "postofficex-config-"));
    const defaultsPath = join(rootDir, "defaults.json");
    const localPath = join(rootDir, "local.json");
    const usersPath = join(rootDir, "users.json");

    await writeJson(defaultsPath, {
      server: {
        smtp: {
          host: "0.0.0.0",
          port: 25
        }
      },
      outbound: {
        connectTimeoutMs: 30000,
        preferStartTls: true
      },
      tls: {
        certFile: "./certs/server.crt",
        keyFile: "./certs/server.key"
      },
      storage: {
        rootDir: "./data"
      }
    });
    await writeJson(localPath, {
      hostname: "mail.example.test",
      domains: ["example.test"]
    });
    await writeJson(usersPath, [
      {
        username: "alice",
        mailbox: "alice",
        passwordHash: "$argon2id$demo",
        addresses: ["alice@example.test"]
      }
    ]);

    const config = await loadConfig(localPath);
    config.hostname = "mail.changed.test";
    config.server.smtp.hostname = "smtp.changed.test";
    config.outbound.greetingHostname = "ehlo.changed.test";
    config.domains = ["example.test", "example.net"];
    config.local = {
      ...config.local,
      server: {
        ...(config.local.server ?? {}),
        smtp: {
          ...(config.local.server?.smtp ?? {}),
          hostname: "smtp.changed.test"
        }
      },
      outbound: {
        ...(config.local.outbound ?? {}),
        greetingHostname: "ehlo.changed.test"
      }
    };
    config.users.push({
      username: "support",
      mailbox: "shared",
      passwordHash: "$argon2id$support",
      addresses: ["support@example.test", "help@example.net"]
    });

    await saveConfig(config);

    expect(JSON.parse(await readFile(defaultsPath, "utf8")).server.smtp.port).toBe(25);
    expect(JSON.parse(await readFile(localPath, "utf8"))).toEqual({
      hostname: "mail.changed.test",
      domains: ["example.test", "example.net"],
      server: {
        smtp: {
          hostname: "smtp.changed.test"
        }
      },
      outbound: {
        greetingHostname: "ehlo.changed.test"
      }
    });
    expect(JSON.parse(await readFile(usersPath, "utf8"))).toHaveLength(2);
  });

  test("fails clearly when local.json is used without defaults.json", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "postofficex-config-"));
    const localPath = join(rootDir, "local.json");
    const usersPath = join(rootDir, "users.json");

    await writeJson(localPath, {
      hostname: "mail.example.test",
      domains: ["example.test"]
    });
    await writeJson(usersPath, []);

    await expect(loadConfig(localPath)).rejects.toMatchObject({
      code: "ENOENT",
      path: join(rootDir, "defaults.json")
    });
  });

  test("rejects duplicate addresses across users", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "postofficex-config-"));
    const defaultsPath = join(rootDir, "defaults.json");
    const localPath = join(rootDir, "local.json");
    const usersPath = join(rootDir, "users.json");

    await writeJson(defaultsPath, {});
    await writeJson(localPath, {
      hostname: "mail.example.test",
      domains: ["example.test"]
    });
    await writeJson(usersPath, [
      {
        username: "alice",
        mailbox: "alice",
        passwordHash: "$argon2id$alice",
        addresses: ["shared@example.test"]
      },
      {
        username: "bob",
        mailbox: "bob",
        passwordHash: "$argon2id$bob",
        addresses: ["shared@example.test"]
      }
    ]);

    await expect(loadConfig(localPath)).rejects.toThrow('Duplicate address "shared@example.test"');
  });
});
