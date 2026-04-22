import { describe, expect, test } from "bun:test";
import { formatStartupError } from "../src/index.js";

describe("startup errors", () => {
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
});
