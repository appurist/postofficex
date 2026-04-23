import { describe, expect, test } from "bun:test";
import { argsRequestVersion, formatStartupError } from "../src/index.js";
import { setupServer } from "./helpers.js";
import { APP_NAME, APP_VERSION, formatVersionLine } from "../src/version.js";

describe("startup errors", () => {
  test("detects version cli flags", () => {
    expect(argsRequestVersion(["--version"])).toBe(true);
    expect(argsRequestVersion(["-v"])).toBe(true);
    expect(argsRequestVersion(["--help"])).toBe(false);
    expect(formatVersionLine()).toBe(`${APP_NAME} ${APP_VERSION}`);
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

    const message = formatStartupError(error, "/srv/postofficex/config.json");

    expect(message).toContain("Configuration file not found");
    expect(message).toContain("/srv/postofficex/config.json");
    expect(message).toContain("config.example.json");
    expect(message).toContain("POSTOFFICEX_CONFIG");
  });

  test("formats invalid json errors clearly", () => {
    const error = new SyntaxError("Unexpected token } in JSON at position 10");

    const message = formatStartupError(error, "/srv/postofficex/config.json");

    expect(message).toContain("is not valid JSON");
    expect(message).toContain("/srv/postofficex/config.json");
  });

  test("preserves explicit listen failure context", () => {
    const error = new Error("Failed to listen on mail.postofficex.com:80: EADDRINUSE");

    const message = formatStartupError(error, "/srv/postofficex/config.json");

    expect(message).toContain("mail.postofficex.com:80");
    expect(message).toContain("EADDRINUSE");
  });

  test("preserves explicit admin listen failure context", () => {
    const error = new Error("Failed to listen on 0.0.0.0:80: Failed to listen at 0.0.0.0");

    const message = formatStartupError(error, "/srv/postofficex/config.json");

    expect(message).toContain("0.0.0.0:80");
    expect(message).toContain("Failed to listen at 0.0.0.0");
  });

  test("server.stop is idempotent while listeners are already closing", async () => {
    const active = await setupServer();

    await expect(active.server.stop()).resolves.toBeUndefined();
    await expect(active.server.stop()).resolves.toBeUndefined();
  });
});
