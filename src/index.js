import { access } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { PostOfficeServer } from "./server.js";
import { MailboxStore } from "./storage.js";
import { formatVersionLine } from "./version.js";

const DEFAULT_CONFIG_PATHS = ["./data/local.json", "/etc/postofficex/local.json"];
export function argsRequestVersion(argv = process.argv.slice(2)) {
  return argv.includes("--version") || argv.includes("-v");
}

export function parseConfigPathArg(argv = process.argv.slice(2)) {
  const index = argv.findIndex((item) => item === "--config" || item === "-c");
  if (index === -1) {
    return null;
  }

  const value = argv[index + 1]?.trim();
  if (!value) {
    throw new Error("Missing value for --config");
  }
  return value;
}

export async function resolveConfigPath(argv = process.argv.slice(2)) {
  const explicitPath = parseConfigPathArg(argv);
  if (explicitPath) {
    return explicitPath;
  }

  for (const candidate of DEFAULT_CONFIG_PATHS) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return DEFAULT_CONFIG_PATHS[0];
}

export function formatStartupError(error, resolvedConfigPath = DEFAULT_CONFIG_PATHS[0]) {
  if (error && typeof error === "object") {
    if (error.code === "ENOENT") {
      const missingPath = error.path ?? resolvedConfigPath;
      return `Configuration file not found at ${missingPath}. Ensure local.json, defaults.json, and users.json exist together in the same config directory, or pass --config /path/to/local.json.`;
    }

    if (error instanceof SyntaxError) {
      if (error.message.startsWith("Configuration file at ")) {
        return error.message;
      }
      return `Configuration file at ${resolvedConfigPath} is not valid JSON: ${error.message}`;
    }

    if (error.code === "EACCES" || error.code === "EPERM") {
      return `Configuration file at ${resolvedConfigPath} could not be read due to permissions. Check file access and retry.`;
    }
  }

  return error instanceof Error ? error.stack ?? error.message : `${error}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argsRequestVersion()) {
    console.log(formatVersionLine());
    return;
  }

  const configPath = await resolveConfigPath(argv);
  const config = await loadConfig(configPath);
  const store = new MailboxStore(config);
  const server = new PostOfficeServer(config, store, logger);
  await server.start();
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("server.stopping", { signal });
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => {
    void server
      .reloadTlsMaterial()
      .then((reloaded) => {
        if (reloaded) {
          logger.info("server.tls_reloaded", {
            certFile: server.config.tls.certFile,
            keyFile: server.config.tls.keyFile
          });
        }
      })
      .catch((error) => {
        logger.error("server.tls_reload_failed", {
          certFile: server.config.tls.certFile,
          keyFile: server.config.tls.keyFile,
          message: error instanceof Error ? error.message : `${error}`
        });
      });
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  void main().catch((error) => {
    let configPath = DEFAULT_CONFIG_PATHS[0];
    try {
      configPath = parseConfigPathArg(argv) ?? configPath;
    } catch {}
    logger.error("server.crash", { configPath });
    console.log(formatStartupError(error, configPath));
    process.exit(1);
  });
}
