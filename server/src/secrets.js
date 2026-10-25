// Encrypts secrets Shoal has to store but must be able to use again, like a
// builder agent's webhook signing secret: AES-256-GCM with a key derived from
// SHOAL_AUTH_SECRET. Without that setting nothing can be stored, because a
// random key would make the secrets unreadable after a restart.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const key = () => {
  if (!process.env.SHOAL_AUTH_SECRET) throw Object.assign(new Error("Set SHOAL_AUTH_SECRET on the server to store secrets"), { status: 503 });
  return createHash("sha256").update(`shoal-stored-secret:${process.env.SHOAL_AUTH_SECRET}`).digest();
};

export function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(String(text)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function decrypt(sealed) {
  const raw = Buffer.from(String(sealed), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
}

export const newSecret = () => `shoal_whsec_${randomBytes(24).toString("base64url")}`;
