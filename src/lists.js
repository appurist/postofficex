import { randomBytes } from "node:crypto";
import { normalizeAddress, parseHeaders, sha256, splitMessage } from "./util.js";

export const NEWSLETTER_CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createListToken() {
  return randomBytes(24).toString("base64url");
}

export function hashListToken(token) {
  return sha256(token);
}

export function normalizeNewsletter(newsletter, user, sourcePath, index) {
  const enabled = Boolean(newsletter?.enabled);
  const publicSubscription = Boolean(newsletter?.publicSubscription);
  const publicUnsubscribe = Boolean(newsletter?.publicUnsubscribe);
  const address = normalizeAddress(`${newsletter?.address ?? user.addresses[0] ?? ""}`);
  const title = `${newsletter?.title ?? `${user.username} newsletter`}`.trim() || `${user.username} newsletter`;

  if (enabled && !user.addresses.includes(address)) {
    throw new Error(
      `Newsletter address "${address}" for user entry ${index + 1} in ${sourcePath} must be one of that user's addresses.`
    );
  }

  const subscriberMap = new Map();
  for (const subscriber of Array.isArray(newsletter?.subscribers) ? newsletter.subscribers : []) {
    const email = normalizeAddress(`${subscriber?.email ?? ""}`);
    const unsubscribeTokenHash = `${subscriber?.unsubscribeTokenHash ?? ""}`.trim();
    if (!email || subscriberMap.has(email)) {
      continue;
    }
    subscriberMap.set(email, {
      email,
      subscribedAt: `${subscriber?.subscribedAt ?? new Date().toISOString()}`,
      unsubscribeTokenHash
    });
  }

  const pendingMap = new Map();
  for (const pending of Array.isArray(newsletter?.pendingSubscriptions) ? newsletter.pendingSubscriptions : []) {
    const email = normalizeAddress(`${pending?.email ?? ""}`);
    const confirmationTokenHash = `${pending?.confirmationTokenHash ?? ""}`.trim();
    if (!email || !confirmationTokenHash || pendingMap.has(email)) {
      continue;
    }
    pendingMap.set(email, {
      email,
      confirmationTokenHash,
      unsubscribeTokenHash: `${pending?.unsubscribeTokenHash ?? ""}`.trim(),
      requestedAt: `${pending?.requestedAt ?? new Date().toISOString()}`,
      expiresAt: `${pending?.expiresAt ?? new Date(Date.now() + NEWSLETTER_CONFIRMATION_TTL_MS).toISOString()}`
    });
  }

  return {
    enabled,
    address,
    title,
    publicSubscription,
    publicUnsubscribe,
    subscribers: Array.from(subscriberMap.values()).sort((a, b) => a.email.localeCompare(b.email)),
    pendingSubscriptions: Array.from(pendingMap.values()).sort((a, b) => a.email.localeCompare(b.email))
  };
}

export function isNewsletterEnabled(user) {
  return Boolean(user?.newsletter?.enabled && user.newsletter.address);
}

export function findNewsletterByAddress(users, address) {
  const normalized = normalizeAddress(address);
  return users.find((user) => isNewsletterEnabled(user) && user.newsletter.address === normalized) ?? null;
}

export function findNewsletterByMailbox(users, mailbox) {
  const normalized = `${mailbox ?? ""}`.trim().toLowerCase();
  return users.find((user) => user.mailbox === normalized && isNewsletterEnabled(user)) ?? null;
}

export function listSubscribers(user) {
  return (user.newsletter?.subscribers ?? []).filter((subscriber) => subscriber.email);
}

export function findSubscriber(user, email) {
  const normalized = normalizeAddress(email);
  return (user.newsletter?.subscribers ?? []).find((subscriber) => subscriber.email === normalized) ?? null;
}

export function buildPublicListUrl(baseUrl, user) {
  return `${baseUrl.replace(/\/$/, "")}/lists/${encodeURIComponent(user.mailbox)}`;
}

export function buildConfirmUrl(baseUrl, user, email, token) {
  const url = new URL(`${buildPublicListUrl(baseUrl, user)}/confirm`);
  url.searchParams.set("email", normalizeAddress(email));
  url.searchParams.set("token", token);
  return url.toString();
}

export function buildUnsubscribeUrl(baseUrl, user, email, token) {
  const url = new URL(`${buildPublicListUrl(baseUrl, user)}/unsubscribe`);
  url.searchParams.set("email", normalizeAddress(email));
  url.searchParams.set("token", token);
  return url.toString();
}

export function beginSubscription(user, email) {
  const normalized = normalizeAddress(email);
  if (!normalized || !normalized.includes("@")) {
    throw new Error("A valid email address is required.");
  }
  if (findSubscriber(user, normalized)) {
    return { status: "already-subscribed", email: normalized };
  }

  const confirmationToken = createListToken();
  const unsubscribeToken = createListToken();
  const now = new Date();
  const pending = {
    email: normalized,
    confirmationTokenHash: hashListToken(confirmationToken),
    unsubscribeTokenHash: hashListToken(unsubscribeToken),
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + NEWSLETTER_CONFIRMATION_TTL_MS).toISOString()
  };

  const remaining = (user.newsletter.pendingSubscriptions ?? []).filter((item) => item.email !== normalized);
  user.newsletter.pendingSubscriptions = [...remaining, pending].sort((a, b) => a.email.localeCompare(b.email));
  return { status: "pending", email: normalized, confirmationToken, unsubscribeToken };
}

export function confirmSubscription(user, email, token) {
  const normalized = normalizeAddress(email);
  const tokenHash = hashListToken(token ?? "");
  const pending = (user.newsletter.pendingSubscriptions ?? []).find((item) => item.email === normalized);
  if (!pending || pending.confirmationTokenHash !== tokenHash) {
    return { ok: false, reason: "invalid" };
  }
  if (new Date(pending.expiresAt).getTime() < Date.now()) {
    user.newsletter.pendingSubscriptions = user.newsletter.pendingSubscriptions.filter((item) => item.email !== normalized);
    return { ok: false, reason: "expired" };
  }

  const existing = findSubscriber(user, normalized);
  if (!existing) {
    user.newsletter.subscribers = [
      ...(user.newsletter.subscribers ?? []).filter((item) => item.email !== normalized),
      {
        email: normalized,
        subscribedAt: new Date().toISOString(),
        unsubscribeTokenHash: pending.unsubscribeTokenHash
      }
    ].sort((a, b) => a.email.localeCompare(b.email));
  }
  user.newsletter.pendingSubscriptions = user.newsletter.pendingSubscriptions.filter((item) => item.email !== normalized);
  return { ok: true, email: normalized };
}

export function removeSubscriber(user, email, token) {
  const normalized = normalizeAddress(email);
  const subscriber = findSubscriber(user, normalized);
  if (!subscriber) {
    return { ok: false, reason: "missing" };
  }
  if (token !== undefined && subscriber.unsubscribeTokenHash !== hashListToken(token)) {
    return { ok: false, reason: "invalid" };
  }

  user.newsletter.subscribers = user.newsletter.subscribers.filter((item) => item.email !== normalized);
  user.newsletter.pendingSubscriptions = (user.newsletter.pendingSubscriptions ?? []).filter((item) => item.email !== normalized);
  return { ok: true, email: normalized };
}

export function getSubscriberUnsubscribeTokenHash(user, email) {
  return findSubscriber(user, email)?.unsubscribeTokenHash ?? "";
}

function foldHeaderLine(name, value) {
  return `${name}: ${String(value).replace(/\r?\n/g, " ")}`;
}

export function buildEmailMessage({ from, to, subject, text, headers = {}, hostname }) {
  const messageHeaders = [
    foldHeaderLine("From", from),
    foldHeaderLine("To", to),
    foldHeaderLine("Subject", subject),
    foldHeaderLine("Date", new Date().toUTCString()),
    foldHeaderLine("Message-ID", `<${Date.now()}.${randomBytes(8).toString("hex")}@${hostname}>`),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  for (const [name, value] of Object.entries(headers)) {
    messageHeaders.push(foldHeaderLine(name, value));
  }
  return `${messageHeaders.join("\r\n")}\r\n\r\n${text.replace(/\r?\n/g, "\r\n")}\r\n`;
}

export function addNewsletterHeaders(rawMessage, user, subscriberEmail, unsubscribeUrl) {
  const { headerText, bodyText } = splitMessage(rawMessage);
  const headers = parseHeaders(headerText);
  const existing = new Set(Array.from(headers.keys()));
  const additions = [
    ["List-Id", `<${user.mailbox}.${user.newsletter.address.split("@")[1]}>`],
    ["List-Unsubscribe", `<${unsubscribeUrl}>`],
    ["List-Unsubscribe-Post", "List-Unsubscribe=One-Click"],
    ["X-PostOfficeX-List", user.newsletter.address],
    ["X-PostOfficeX-Subscriber", subscriberEmail]
  ].filter(([name]) => !existing.has(name.toLowerCase()));

  if (additions.length === 0) {
    return rawMessage;
  }
  return `${headerText}\r\n${additions.map(([name, value]) => foldHeaderLine(name, value)).join("\r\n")}\r\n\r\n${bodyText}`;
}
