import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
