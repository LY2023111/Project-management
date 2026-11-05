/* 密钥加密单测：AES-256-GCM 往返、密文不含明文、篡改/错密钥必失败 */
const test = require("node:test");
const assert = require("node:assert");
const { encryptSecret, decryptSecret } = require("../server/crypto");

const ENV = { SESSION_SECRET: "unit-test-secret" };

test("加密：可正确解密，密文不含明文", () => {
  const plain = "sk-live-abcdef1234567890";
  const enc = encryptSecret(plain, ENV);
  assert.ok(enc.startsWith("v1:"), "带版本前缀");
  assert.ok(!enc.includes(plain), "密文不得包含明文");
  assert.ok(!enc.includes("abcdef"), "密文不得包含明文片段");
  assert.equal(decryptSecret(enc, ENV), plain);
});

test("加密：同一明文两次加密结果不同（随机 IV）", () => {
  const a = encryptSecret("sk-same-value-123", ENV);
  const b = encryptSecret("sk-same-value-123", ENV);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, ENV), decryptSecret(b, ENV));
});

test("加密：换密钥无法解密、篡改密文报错", () => {
  const enc = encryptSecret("sk-secret-value", ENV);
  assert.throws(() => decryptSecret(enc, { SESSION_SECRET: "another-secret" }));
  // 篡改最后一个字节
  const buf = Buffer.from(enc.slice(3), "base64");
  buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
  const tampered = "v1:" + buf.toString("base64");
  assert.throws(() => decryptSecret(tampered, ENV));
  assert.throws(() => decryptSecret("plaintext-key", ENV), /密文格式/);
});
