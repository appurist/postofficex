export async function verifyPassword(password, hash) {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}
