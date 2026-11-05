/* 敏感配置加密：AES-256-GCM
   - 密钥由 SETTINGS_SECRET（推荐）或 SESSION_SECRET 经 scrypt 派生，不落库、不下发
   - 密文格式：v1:<base64(iv|tag|ciphertext)>
   - 数据库/备份泄露时无法还原明文；更换 SETTINGS_SECRET 会导致旧密文不可解密（需重新录入） */
const crypto = require("crypto");
const SALT = "pmwb-settings-v1";

const keyCache = new Map();
function deriveKey(env) {
  const secret = (env && (env.SETTINGS_SECRET || env.SESSION_SECRET)) || "pmwb-dev-only-secret";
  if (!keyCache.has(secret)) keyCache.set(secret, crypto.scryptSync(secret, SALT, 32));
  return keyCache.get(secret);
}

function encryptSecret(plain, env) {
  if (plain == null || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", deriveKey(env), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return "v1:" + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptSecret(payload, env) {
  if (!payload) return "";
  const s = String(payload);
  const idx = s.indexOf(":");
  if (idx < 0 || s.slice(0, idx) !== "v1") throw new Error("密文格式不正确");
  const buf = Buffer.from(s.slice(idx + 1), "base64");
  if (buf.length < 29) throw new Error("密文长度异常");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", deriveKey(env), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
