/* 系统设置接口（仅管理员）：大模型密钥加密存储、只回模型名、连接测试 */
const express = require("express");
const { getLlmPublicSettings, saveLlmSettings, clearLlmSettings } = require("../settings");
const { resolveLlmConfig, chat } = require("../llm");

module.exports = function settingsRouter(pool, env) {
  const r = express.Router();

  r.get("/llm", async (req, res, next) => {
    try { res.json(await getLlmPublicSettings(pool, env)); } catch (e) { next(e); }
  });

  /* 保存：api_key 留空 = 不修改已存密钥；接口不回传密钥任何内容 */
  r.put("/llm", async (req, res, next) => {
    try {
      const out = await saveLlmSettings(pool, env, req.body || {});
      res.json(out);
    } catch (e) {
      if (/密钥|地址|模型/.test(e.message)) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  r.delete("/llm", async (req, res, next) => {
    try { await clearLlmSettings(pool); res.json(await getLlmPublicSettings(pool, env)); } catch (e) { next(e); }
  });

  /* 测试连接：真实发一条极短请求，验证密钥/地址/模型是否可用 */
  r.post("/llm/test", async (req, res, next) => {
    try {
      const cfg = await resolveLlmConfig(pool, env);
      if (!cfg.ready) return res.status(400).json({ error: "还没有配置密钥，先填写并保存再测试" });
      const t0 = Date.now();
      const out = await chat(cfg, [
        { role: "system", content: "你是连通性测试助手，只需按要求回复。" },
        { role: "user", content: "只回复两个字：正常" },
      ], { maxTokens: 16, temperature: 0 });
      res.json({ ok: true, model: out.model, ms: Date.now() - t0, reply: out.text.slice(0, 60) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return r;
};
