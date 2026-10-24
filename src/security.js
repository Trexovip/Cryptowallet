// Auth + at-rest encryption using Node's built-in crypto (no native deps).
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { get } = require("./config");

// ---- passwords: scrypt with per-hash salt ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, saltHex, hashHex] = stored.split("$");
    const dk = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
    return crypto.timingSafeEqual(dk, Buffer.from(hashHex, "hex"));
  } catch {
    return false;
  }
}

// ---- private-key encryption at rest: AES-256-GCM ----
// Dev posture: key lives in data/config.json. For production, source it from a
// KMS/HSM and inject it, rather than keeping it on disk beside the database.
function keyBuf() {
  return Buffer.from(get().wallet_enc_key, "hex"); // 32 bytes
}
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyBuf(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}
function decryptSecret(blob) {
  const [ivH, tagH, dataH] = blob.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", keyBuf(), Buffer.from(ivH, "hex"));
  d.setAuthTag(Buffer.from(tagH, "hex"));
  return Buffer.concat([d.update(Buffer.from(dataH, "hex")), d.final()]).toString("utf8");
}

// ---- JWT ----
function signToken(user) {
  return jwt.sign({ sub: user.username, role: user.role }, get().app_secret,
    { expiresIn: `${get().access_token_minutes || 60}m` });
}
function verifyToken(tok) {
  return jwt.verify(tok, get().app_secret);
}

module.exports = {
  hashPassword, verifyPassword, encryptSecret, decryptSecret, signToken, verifyToken,
};
