import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function normalizeAddress(value) {
  return value.trim().toLowerCase();
}

export function stripSmtpPath(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^<\s*([^>]+)\s*>$/);
  return normalizeAddress(match ? match[1] : trimmed);
}

export function ensureTrailingCrlf(raw) {
  return raw.endsWith("\r\n") ? raw : `${raw}\r\n`;
}

export function parseHeaders(rawHeaders) {
  const lines = rawHeaders.split(/\r?\n/);
  const headers = new Map();
  let currentKey = null;

  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
      headers.set(currentKey, `${headers.get(currentKey) ?? ""} ${line.trim()}`.trim());
      continue;
    }

    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }

    currentKey = line.slice(0, index).trim().toLowerCase();
    headers.set(currentKey, line.slice(index + 1).trim());
  }

  return headers;
}

export function splitMessage(raw) {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator !== -1) {
    return {
      headerText: raw.slice(0, separator),
      bodyText: raw.slice(separator + 4)
    };
  }

  const lfSeparator = raw.indexOf("\n\n");
  if (lfSeparator !== -1) {
    return {
      headerText: raw.slice(0, lfSeparator),
      bodyText: raw.slice(lfSeparator + 2)
    };
  }

  return { headerText: raw, bodyText: "" };
}

export function getHeader(raw, name) {
  const { headerText } = splitMessage(raw);
  const headers = parseHeaders(headerText);
  return headers.get(name.toLowerCase()) ?? null;
}

export function generateMessageId(hostname) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const random = randomBytes(8).toString("hex");
  return `${timestamp}-${random}@${hostname}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

export async function ensureParentDirectory(path) {
  await mkdir(dirname(path), { recursive: true });
}

export function resolveFrom(baseDir, candidate) {
  return resolve(baseDir, candidate);
}
