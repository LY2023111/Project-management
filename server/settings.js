/* 大模型设置的读写：数据库密文优先，.env 作为可选的兜底（推荐只在页面录入） */
const { encryptSecret, decryptSecret } = require("./crypto");

const K_KEY = "llm_api_key";
const K_BASE = "llm_base_url";
const K_MODEL = "llm_model";
const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

async function readMap(pool) {
  const [rows] = await pool.query("SELECT k, v FROM app_settings WHERE k IN (?,?,?)", [K_KEY, K_BASE, K_MODEL]);
  const map = {};
  rows.forEach((r) => { map[r.k] = r.v; });
  return map;
}

/* 解析出可用配置：返回明文密钥仅限服务端内部使用，绝不直接下发前端 */
async function getLlmSettings(pool, env) {
  let map = {};
  try { map = await readMap(pool); } catch (_) { map = {}; }

  let apiKey = "";
  let corrupt = false;
  if (map[K_KEY]) {
    try { apiKey = decryptSecret(map[K_KEY], env); } catch (_) { corrupt = true; apiKey = ""; }
  }
  const envKey = (env && (env.LLM_API_KEY || env.OPENAI_API_KEY)) || "";
  const dbSource = !!apiKey;
  const source = dbSource ? "db" : (envKey ? "env" : "");
  return {
    api_key: apiKey || envKey,
    base_url: map[K_BASE] || (env && env.LLM_BASE_URL) || DEFAULT_BASE,
    model: map[K_MODEL] || (env && env.LLM_MODEL) || DEFAULT_MODEL,
    source,
    corrupt,
  };
}

/* 对外展示用：不返回密钥的任何片段（连掩码都不给），只告诉前端「是否已配置 + 当前模型」 */
async function getLlmPublicSettings(pool, env) {
  const s = await getLlmSettings(pool, env);
  return {
    configured: !!s.api_key,
    source: s.source,
    base_url: s.base_url,
    model: s.model,
    corrupt: !!s.corrupt,
    editable: true,
  };
}

async function upsert(pool, k, v) {
  await pool.query(
    "INSERT INTO app_settings(k,v) VALUES(?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)",
    [k, v == null ? "" : String(v)]
  );
}

/* body: {api_key, base_url, model}；api_key 为空字符串表示「不修改已存的密钥」 */
async function saveLlmSettings(pool, env, body) {
  const b = body || {};
  if (b.api_key != null && String(b.api_key).trim()) {
    const key = String(b.api_key).trim();
    if (key.length < 8) throw new Error("密钥长度看起来不对（至少 8 位）");
    await upsert(pool, K_KEY, encryptSecret(key, env)); // 只存密文
  }
  if (b.base_url != null) {
    const base = String(b.base_url).trim();
    if (base && !/^https?:\/\/[^\s]+$/i.test(base)) throw new Error("接口地址需以 http:// 或 https:// 开头");
    await upsert(pool, K_BASE, base);
  }
  if (b.model != null) {
    const model = String(b.model).trim();
    if (model.length > 60) throw new Error("模型名过长");
    await upsert(pool, K_MODEL, model);
  }
  return getLlmPublicSettings(pool, env);
}

async function clearLlmSettings(pool) {
  await pool.query("DELETE FROM app_settings WHERE k IN (?,?,?)", [K_KEY, K_BASE, K_MODEL]);
}

module.exports = {
  getLlmSettings, getLlmPublicSettings, saveLlmSettings, clearLlmSettings,
  DEFAULT_BASE, DEFAULT_MODEL,
};
