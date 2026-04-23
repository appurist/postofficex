import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argsRequestVersion, formatStartupError, parseConfigPathArg, resolveConfigPath } from "../src/index.js";
import { setupServer } from "./helpers.js";
import { APP_NAME, APP_VERSION, formatVersionLine } from "../src/version.js";

describe("startup errors", () => {
  test("detects version cli flags", () => {
    expect(argsRequestVersion(["--version"])).toBe(true);
    expect(argsRequestVersion(["-v"])).toBe(true);
    expect(argsRequestVersion(["--help"])).toBe(false);
    expect(formatVersionLine()).toBe(`${APP_NAME} ${APP_VERSION}`);
  });

  test("parses explicit config cli flags", () => {
    expect(parseConfigPathArg(["--config", "/etc/postofficex/local.json"])).toBe("/etc/postofficex/local.json");
    expect(parseConfigPathArg(["-c", "./local.json"])).toBe("./local.json");
    expect(parseConfigPathArg(["--help"])).toBe(null);
    expect(() => parseConfigPathArg(["--config"])).toThrow("Missing value for --config");
  });

  test("prefers an explicit config cli flag over defaults", async () => {
    expect(await resolveConfigPath(["--config", "/srv/postofficex/local.json"])).toBe("/srv/postofficex/local.json");
  });

  test("falls back to the working directory local.json when present", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "postofficex-startup-"));
    const localPath = join(rootDir, "local.json");
    await writeFile(localPath, "{}", "utf8");
    const previousCwd = process.cwd();
    process.chdir(rootDir);
    try {
      expect(await resolveConfigPath([])).toBe("./local.json");
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("prints the version from the cli", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "run", "src/index.js", "--version"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe"
    });

    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(formatVersionLine());
    expect(stderr.trim()).toBe("");
  });

  test("formats missing config errors clearly", () => {
    const error = new Error("missing");
    error.code = "ENOENT";

    const message = formatStartupError(error, "/srv/postofficex/local.json");

    expect(message).toContain("Configuration file not found");
    expect(message).toContain("/srv/postofficex/local.json");
    expect(message).toContain("defaults.json");
    expect(message).toContain("users.json");
    expect(message).toContain("--config");
  });

  test("formats invalid json errors clearly", () => {
    const error = new SyntaxError("Unexpected token } in JSON at position 10");

    const message = formatStartupError(error, "/srv/postofficex/local.json");

    expect(message).toContain("is not valid JSON");
    expect(message).toContain("/srv/postofficex/local.json");
  });

  test("preserves referenced config file paths for missing files", () => {
    const error = new Error("missing");
    error.code = "ENOENT";
    error.path = "/srv/postofficex/users.json";

    const message = formatStartupError(error, "/srv/postofficex/local.json");

    expect(message).toContain("/srv/postofficex/users.json");
  });

  test("preserves referenced config file paths for invalid json", () => {
    const error = new SyntaxError(
      "Configuration file at /srv/postofficex/defaults.json is not valid JSON: Unexpected token }"
    );

    const message = formatStartupError(error, "/srv/postofficex/local.json");

    expect(message).toContain("/srv/postofficex/defaults.json");
    expect(message).not.toContain("/srv/postofficex/local.json is not valid JSON");
  });

  test("preserves explicit listen failure context", () => {
    const error = new Error("Failed to listen on mail.postofficex.com:80: EADDRINUSE");

    const message = formatStartupError(error, "/srv/postofficex/local.json");

    expect(message).toContain("mail.postofficex.com:80");
    expect(message).toContain("EADDRINUSE");
  });

  test("preserves explicit admin listen failure context", () => {
    const error = new Error("Failed to listen on 0.0.0.0:80: Failed to listen at 0.0.0.0");

    const message = formatStartupError(error, "/srv/postofficex/local.json");

    expect(message).toContain("0.0.0.0:80");
    expect(message).toContain("Failed to listen at 0.0.0.0");
  });

  test("server.stop is idempotent while listeners are already closing", async () => {
    const active = await setupServer();

    await expect(active.server.stop()).resolves.toBeUndefined();
    await expect(active.server.stop()).resolves.toBeUndefined();
  });
});
