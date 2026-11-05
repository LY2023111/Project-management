/* 大模型调用：OpenAI 兼容接口（DeepSeek / 通义千问 / Moonshot / OpenAI 均可）
   配置来源：数据库加密存储（管理页录入）优先，其次才看 .env 的 LLM_API_KEY。
   密钥只在服务端解密后用于请求头，不写日志、不下发前端。 */
const { getLlmSettings } = require("./settings");

const DEFAULTS = { base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", timeout: 90000 };

async function resolveLlmConfig(pool, env) {
  const s = await getLlmSettings(pool, env);
  return {
    api_key: s.api_key,
    base_url: (s.base_url || DEFAULTS.base_url).replace(/\/+$/, ""),
    model: s.model || DEFAULTS.model,
    timeout: Number((env && env.LLM_TIMEOUT_MS) || DEFAULTS.timeout),
    source: s.source,
    ready: !!s.api_key,
  };
}

async function chat(cfg, messages, opts = {}) {
  if (!cfg || !cfg.api_key) throw new Error("未配置大模型密钥，已改用本地模板生成");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout || DEFAULTS.timeout);
  try {
    const r = await fetch(cfg.base_url + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.api_key },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature == null ? 0.4 : opts.temperature,
        max_tokens: opts.maxTokens || 1800,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (d.error && (d.error.message || d.error.type)) || ("模型服务返回 " + r.status);
      throw new Error(msg);
    }
    const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!text || !String(text).trim()) throw new Error("模型返回内容为空");
    return { text: String(text).trim(), model: d.model || cfg.model };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("模型响应超时（" + Math.round((cfg.timeout || DEFAULTS.timeout) / 1000) + "s）");
    throw new Error("模型调用失败：" + e.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resolveLlmConfig, chat };
