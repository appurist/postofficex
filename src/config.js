import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { normalizeAddress, resolveFrom } from "./util.js";

export async function loadConfig(configPath) {
  const absolutePath = resolve(configPath);
  const configDir = dirname(absolutePath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8"));

  const domains = parsed.domains.map((domain) => domain.toLowerCase());
  const users = parsed.users.map((user) => ({
    ...user,
    username: user.username.toLowerCase(),
    mailbox: user.mailbox.toLowerCase(),
    addresses: user.addresses.map(normalizeAddress)
  }));

  return {
    ...parsed,
    configPath: absolutePath,
    configDir,
    admin: {
      host: parsed.admin?.host ?? "0.0.0.0",
      port: parsed.admin?.port ?? 80,
      password: parsed.admin?.password ?? "",
      passwordHash: parsed.admin?.passwordHash ?? ""
    },
    storage: {
      rootDir: resolveFrom(configDir, parsed.storage.rootDir)
    },
    tls: {
      certFile: resolveFrom(configDir, parsed.tls.certFile),
      keyFile: resolveFrom(configDir, parsed.tls.keyFile)
    },
    domains,
    users
  };
}

export function buildUserDirectory(config) {
  const usersByUsername = new Map();
  const usersByAddress = new Map();

  for (const user of config.users) {
    usersByUsername.set(user.username, user);
    for (const address of user.addresses) {
      usersByAddress.set(address, user);
    }
  }

  return { usersByUsername, usersByAddress };
}

function toConfigPath(configDir, value) {
  const relativePath = relative(configDir, value);
  if (!relativePath || (!relativePath.startsWith("..") && !relativePath.includes(":"))) {
    return relativePath ? `./${relativePath.replace(/\\/g, "/")}` : ".";
  }

  return value;
}

export function serializeConfig(config) {
  return {
    server: config.server,
    tls: {
      certFile: toConfigPath(config.configDir, config.tls.certFile),
      keyFile: toConfigPath(config.configDir, config.tls.keyFile)
    },
    limits: config.limits,
    storage: {
      rootDir: toConfigPath(config.configDir, config.storage.rootDir)
    },
    admin: {
      host: config.admin?.host ?? "0.0.0.0",
      port: config.admin?.port ?? 80,
      password: config.admin?.password ?? "",
      passwordHash: config.admin?.passwordHash ?? ""
    },
    domains: config.domains,
    users: config.users
  };
}

export async function saveConfig(config) {
  const payload = serializeConfig(config);
  await writeFile(config.configPath, JSON.stringify(payload, null, 2), "utf8");
}
