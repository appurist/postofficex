import { verifyPassword } from "./auth.js";

export function normalizeLoginIdentifier(value) {
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split("@");
  if (parts.length === 3 && parts[1] === parts[2]) {
    return `${parts[0]}@${parts[1]}`;
  }

  return normalized;
}

export function findUser(users, username) {
  const normalized = normalizeLoginIdentifier(username);
  return users.usersByUsername.get(normalized) ?? users.usersByAddress.get(normalized) ?? null;
}

export async function authenticateUser(users, username, password) {
  const user = findUser(users, username);
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;
  return valid ? user : null;
}
