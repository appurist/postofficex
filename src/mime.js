import { parseHeaders, splitMessage } from "./util.js";

function getBoundary(contentType) {
  if (!contentType) {
    return null;
  }

  const match = contentType.match(/boundary="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

function getFilename(headers) {
  const disposition = headers.get("content-disposition");
  const contentType = headers.get("content-type");
  const candidates = [disposition, contentType];

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    const match = value.match(/filename\*?="?([^";]+)"?/i) ?? value.match(/name="?([^";]+)"?/i);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function isAttachment(headers) {
  const disposition = headers.get("content-disposition") ?? "";
  return /attachment/i.test(disposition) || disposition.includes("filename=");
}

function estimateSize(body, encoding) {
  if (!encoding) {
    return Buffer.byteLength(body, "utf8");
  }

  if (encoding.toLowerCase() === "base64") {
    const normalized = body.replace(/\s+/g, "");
    return Math.floor((normalized.length * 3) / 4);
  }

  return Buffer.byteLength(body, "utf8");
}

function splitMultipart(body, boundary) {
  const token = `--${boundary}`;
  const segments = body.split(token);
  const parts = [];

  for (const segment of segments) {
    const cleaned = segment.replace(/^\r?\n/, "").trimEnd();
    if (!cleaned || cleaned === "--") {
      continue;
    }
    if (cleaned.endsWith("--")) {
      parts.push(cleaned.slice(0, -2).trimEnd());
    } else {
      parts.push(cleaned);
    }
  }

  return parts;
}

function collectParts(rawPart, prefix, attachments) {
  const { headerText, bodyText } = splitMessage(rawPart);
  const headers = parseHeaders(headerText);
  const contentType = headers.get("content-type") ?? "text/plain";
  const encoding = headers.get("content-transfer-encoding");

  if (contentType.toLowerCase().startsWith("multipart/")) {
    const boundary = getBoundary(contentType);
    if (!boundary) {
      return;
    }

    const nestedParts = splitMultipart(bodyText, boundary);
    nestedParts.forEach((part, index) => collectParts(part, `${prefix}.${index + 1}`, attachments));
    return;
  }

  if (!isAttachment(headers) && !getFilename(headers)) {
    return;
  }

  attachments.push({
    filename: getFilename(headers),
    contentType,
    size: estimateSize(bodyText, encoding),
    disposition: headers.get("content-disposition"),
    contentTransferEncoding: encoding,
    partId: prefix
  });
}

export function extractAttachmentMetadata(rawMessage) {
  const { headerText, bodyText } = splitMessage(rawMessage);
  const headers = parseHeaders(headerText);
  const contentType = headers.get("content-type") ?? "text/plain";

  if (!contentType.toLowerCase().startsWith("multipart/")) {
    return [];
  }

  const boundary = getBoundary(contentType);
  if (!boundary) {
    return [];
  }

  const attachments = [];
  const parts = splitMultipart(bodyText, boundary);
  parts.forEach((part, index) => collectParts(part, `${index + 1}`, attachments));
  return attachments;
}
