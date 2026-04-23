import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { normalizeAddress, resolveFrom } from "./util.js";

const DEFAULTS_CONFIG_NAME = "defaults.json";
const USERS_CONFIG_NAME = "users.json";

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      const wrapped = new SyntaxError(`Configuration file at ${path} is not valid JSON: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

function ensureObject(value, description, path) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${description} at ${path} must be a JSON object.`);
  }
}

function normalizeUsers(users, sourcePath) {
  if (!Array.isArray(users)) {
    throw new Error(`Users config at ${sourcePath} must be a JSON array.`);
  }

  const seenUsernames = new Set();
  const seenAddresses = new Set();

  return users.map((user, index) => {
    ensureObject(user, `User entry ${index + 1}`, sourcePath);
    const username = `${user.username ?? ""}`.trim().toLowerCase();
    const mailbox = `${user.mailbox ?? ""}`.trim().toLowerCase();
    const addresses = Array.isArray(user.addresses) ? user.addresses.map(normalizeAddress) : [];

    if (!username || !mailbox || addresses.length === 0) {
      throw new Error(
        `User entry ${index + 1} in ${sourcePath} must include username, mailbox, and at least one address.`
      );
    }

    if (seenUsernames.has(username)) {
      throw new Error(`Duplicate username "${username}" found in ${sourcePath}.`);
    }
    seenUsernames.add(username);

    for (const address of addresses) {
      if (seenAddresses.has(address)) {
        throw new Error(`Duplicate address "${address}" found in ${sourcePath}.`);
      }
      seenAddresses.add(address);
    }

    return {
      ...user,
      username,
      mailbox,
      addresses
    };
  });
}

function normalizeDomains(domains, sourcePath) {
  if (!Array.isArray(domains)) {
    throw new Error(`Domains config at ${sourcePath} must provide a domains array.`);
  }

  return domains.map((domain) => `${domain}`.trim().toLowerCase()).filter(Boolean);
}

function isObject(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) {
    return override === undefined ? base : override;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function sanitizeForDiff(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeForDiff);
  }
  if (!isObject(value)) {
    return value;
  }

  const next = {};
  for (const [key, current] of Object.entries(value)) {
    if (current === undefined) {
      continue;
    }
    const sanitized = sanitizeForDiff(current);
    if (sanitized === undefined) {
      continue;
    }
    if (isObject(sanitized) && Object.keys(sanitized).length === 0) {
      continue;
    }
    next[key] = sanitized;
  }
  return next;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepDiff(base, value) {
  if (deepEqual(base, value)) {
    return undefined;
  }

  if (Array.isArray(base) || Array.isArray(value) || !isObject(base) || !isObject(value)) {
    return value;
  }

  const diff = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(value)]);
  for (const key of keys) {
    const current = deepDiff(base[key], value[key]);
    if (current !== undefined) {
      diff[key] = current;
    }
  }

  return Object.keys(diff).length > 0 ? diff : undefined;
}

function toConfigPath(configDir, value) {
  const relativePath = relative(configDir, value);
  if (!relativePath || (!relativePath.startsWith("..") && !relativePath.includes(":"))) {
    return relativePath ? `./${relativePath.replace(/\\/g, "/")}` : ".";
  }

  return value;
}

function configPaths(localPath) {
  const absoluteLocalPath = resolve(localPath);
  const configDir = dirname(absoluteLocalPath);
  return {
    localConfigPath: absoluteLocalPath,
    configDir,
    defaultsConfigPath: resolve(configDir, DEFAULTS_CONFIG_NAME),
    usersConfigPath: resolve(configDir, USERS_CONFIG_NAME)
  };
}

function buildNormalizedConfig(merged, sources, users) {
  const hostname = `${merged.hostname ?? ""}`.trim() || `${merged.server?.smtp?.hostname ?? ""}`.trim() || "mail.example.test";
  const smtpHostname = `${merged.server?.smtp?.hostname ?? ""}`.trim() || hostname;
  const outboundGreetingHostname = `${merged.outbound?.greetingHostname ?? ""}`.trim() || smtpHostname;

  return {
    ...merged,
    hostname,
    configPath: sources.localConfigPath,
    configDir: sources.configDir,
    sources,
    server: {
      smtp: {
        host: merged.server?.smtp?.host ?? "0.0.0.0",
        port: merged.server?.smtp?.port ?? 25,
        hostname: smtpHostname,
        allowPlaintext: merged.server?.smtp?.allowPlaintext ?? true,
        enableStartTls: merged.server?.smtp?.enableStartTls ?? true
      },
      submission: {
        host: merged.server?.submission?.host ?? "0.0.0.0",
        port: merged.server?.submission?.port ?? 587,
        tlsPort: merged.server?.submission?.tlsPort ?? 465,
        allowPlaintext: merged.server?.submission?.allowPlaintext ?? false,
        enableStartTls: merged.server?.submission?.enableStartTls ?? true,
        enableTls: merged.server?.submission?.enableTls ?? true
      },
      pop3: {
        host: merged.server?.pop3?.host ?? "0.0.0.0",
        port: merged.server?.pop3?.port ?? 110,
        tlsPort: merged.server?.pop3?.tlsPort ?? 995,
        allowPlaintext: merged.server?.pop3?.allowPlaintext ?? false,
        enableStartTls: merged.server?.pop3?.enableStartTls ?? false,
        enableTls: merged.server?.pop3?.enableTls ?? true
      },
      imap: {
        host: merged.server?.imap?.host ?? "0.0.0.0",
        port: merged.server?.imap?.port ?? 143,
        tlsPort: merged.server?.imap?.tlsPort ?? 993,
        allowPlaintext: merged.server?.imap?.allowPlaintext ?? false,
        enableStartTls: merged.server?.imap?.enableStartTls ?? false,
        enableTls: merged.server?.imap?.enableTls ?? true
      }
    },
    outbound: {
      greetingHostname: outboundGreetingHostname,
      connectTimeoutMs: merged.outbound?.connectTimeoutMs ?? 30000,
      preferStartTls: merged.outbound?.preferStartTls ?? true
    },
    admin: {
      host: merged.admin?.host ?? "0.0.0.0",
      port: merged.admin?.port ?? 80,
      enableTls: merged.admin?.enableTls ?? false,
      logRequests: merged.admin?.logRequests ?? false,
      password: merged.admin?.password ?? "",
      passwordHash: merged.admin?.passwordHash ?? ""
    },
    storage: {
      rootDir: resolveFrom(sources.configDir, merged.storage?.rootDir ?? "./data")
    },
    tls: {
      certFile: resolveFrom(sources.configDir, merged.tls?.certFile ?? "./certs/server.crt"),
      keyFile: resolveFrom(sources.configDir, merged.tls?.keyFile ?? "./certs/server.key")
    },
    domains: normalizeDomains(merged.domains ?? [], sources.localConfigPath),
    users
  };
}

function buildLayeredPayload(config, { preserveRuntimeOverrides = false } = {}) {
  const local = preserveRuntimeOverrides ? config.local ?? {} : {};
  const payload = sanitizeForDiff({
    hostname: `${config.hostname ?? ""}`.trim() || undefined,
    server: {
      smtp: {
        host: config.server.smtp.host,
        port: config.server.smtp.port,
        hostname:
          local.server?.smtp && Object.prototype.hasOwnProperty.call(local.server.smtp, "hostname")
            ? `${local.server.smtp.hostname ?? ""}`.trim() || undefined
            : undefined,
        allowPlaintext: config.server.smtp.allowPlaintext,
        enableStartTls: config.server.smtp.enableStartTls
      },
      submission: {
        host: config.server.submission.host,
        port: config.server.submission.port,
        tlsPort: config.server.submission.tlsPort,
        allowPlaintext: config.server.submission.allowPlaintext,
        enableStartTls: config.server.submission.enableStartTls,
        enableTls: config.server.submission.enableTls
      },
      pop3: {
        host: config.server.pop3.host,
        port: config.server.pop3.port,
        tlsPort: config.server.pop3.tlsPort,
        allowPlaintext: config.server.pop3.allowPlaintext,
        enableStartTls: config.server.pop3.enableStartTls,
        enableTls: config.server.pop3.enableTls
      },
      imap: {
        host: config.server.imap.host,
        port: config.server.imap.port,
        tlsPort: config.server.imap.tlsPort,
        allowPlaintext: config.server.imap.allowPlaintext,
        enableStartTls: config.server.imap.enableStartTls,
        enableTls: config.server.imap.enableTls
      }
    },
    outbound: {
      greetingHostname:
        local.outbound && Object.prototype.hasOwnProperty.call(local.outbound, "greetingHostname")
          ? `${local.outbound.greetingHostname ?? ""}`.trim() || undefined
          : undefined,
      connectTimeoutMs: config.outbound.connectTimeoutMs,
      preferStartTls: config.outbound.preferStartTls
    },
    tls: {
      certFile: toConfigPath(config.sources.configDir, config.tls.certFile),
      keyFile: toConfigPath(config.sources.configDir, config.tls.keyFile)
    },
    limits: {
      maxMessageBytes: config.limits?.maxMessageBytes ?? 10 * 1024 * 1024,
      maxRecipientsPerMessage: config.limits?.maxRecipientsPerMessage ?? 64,
      maxMailboxBytes: config.limits?.maxMailboxBytes ?? 50 * 1024 * 1024,
      socketTimeoutMs: config.limits?.socketTimeoutMs ?? 300000,
      maxInvalidAuthAttempts: config.limits?.maxInvalidAuthAttempts ?? 10
    },
    storage: {
      rootDir: toConfigPath(config.sources.configDir, config.storage.rootDir)
    },
    admin: {
      host: config.admin?.host ?? "0.0.0.0",
      port: config.admin?.port ?? 80,
      enableTls: config.admin?.enableTls ?? false,
      logRequests: config.admin?.logRequests ?? false,
      password: config.admin?.password ?? "",
      passwordHash: config.admin?.passwordHash ?? ""
    },
    domains: config.domains
  });

  if (!preserveRuntimeOverrides) {
    return payload;
  }

  return deepMerge(local, payload);
}

function buildDefaultsBaseline(defaults, sources) {
  const normalized = buildNormalizedConfig(defaults, { ...sources, localConfigPath: sources.defaultsConfigPath }, []);
  return buildLayeredPayload({
    ...normalized,
    local: defaults
  });
}

export async function loadConfig(localConfigPath) {
  const sources = {
    mode: "layered",
    ...configPaths(localConfigPath)
  };

  const [defaultsParsed, localParsed, usersParsed] = await Promise.all([
    readJsonFile(sources.defaultsConfigPath),
    readJsonFile(sources.localConfigPath),
    readJsonFile(sources.usersConfigPath)
  ]);

  ensureObject(defaultsParsed, "Defaults config", sources.defaultsConfigPath);
  ensureObject(localParsed, "Local config", sources.localConfigPath);

  const users = normalizeUsers(usersParsed, sources.usersConfigPath);
  const merged = deepMerge(defaultsParsed, localParsed);
  const config = buildNormalizedConfig(merged, {
    ...sources,
    defaultsConfigPath: sources.defaultsConfigPath,
    usersConfigPath: sources.usersConfigPath
  }, users);

  config.defaults = defaultsParsed;
  config.local = localParsed;
  return config;
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

export function serializeConfig(config) {
  const baseline = buildDefaultsBaseline(config.defaults ?? {}, config.sources);
  const current = buildLayeredPayload(config, { preserveRuntimeOverrides: true });
  const local = sanitizeForDiff(deepDiff(baseline, current) ?? {});

  return {
    defaults: sanitizeForDiff(config.defaults ?? {}),
    local,
    users: config.users
  };
}

export async function saveConfig(config) {
  const payload = serializeConfig(config);
  await Promise.all([
    writeFile(config.sources.localConfigPath, JSON.stringify(payload.local, null, 2), "utf8"),
    writeFile(config.sources.usersConfigPath, JSON.stringify(payload.users, null, 2), "utf8")
  ]);
}
