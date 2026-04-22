import { rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { PostOfficeServer } from "./server.js";
import { MailboxStore } from "./storage.js";

const configPath = process.env.POSTOFFICEX_CONFIG ?? "./config.json";
const pidFile = process.env.POSTOFFICEX_PID_FILE ?? "";

export function formatStartupError(error, resolvedConfigPath = configPath) {
  if (error && typeof error === "object") {
    if (error.code === "ENOENT") {
      return `Configuration file not found at ${resolvedConfigPath}. Copy config.example.json to config.json or set POSTOFFICEX_CONFIG to the correct path.`;
    }

    if (error instanceof SyntaxError) {
      return `Configuration file at ${resolvedConfigPath} is not valid JSON: ${error.message}`;
    }

    if (error.code === "EACCES" || error.code === "EPERM") {
      return `Configuration file at ${resolvedConfigPath} could not be read due to permissions. Check file access and retry.`;
    }
  }

  return error instanceof Error ? error.stack ?? error.message : `${error}`;
}

async function main() {
  const config = await loadConfig(configPath);
  const store = new MailboxStore(config);
  const server = new PostOfficeServer(config, store, logger);
  await server.start();
  if (pidFile) {
    await writeFile(pidFile, `${process.pid}\n`, "utf8");
  }
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("server.stopping", { signal });
    await server.stop();
    if (pidFile) {
      await rm(pidFile, { force: true });
    }
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
  void main().catch((error) => {
    logger.error("server.crash", { configPath });
    console.log(formatStartupError(error, configPath));
    process.exit(1);
  });
}
