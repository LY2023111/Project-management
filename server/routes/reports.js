/* 周报接口：生成（大模型/模板）、历史、查看、删除 */
const express = require("express");
const { visibleProjectIds, canAccessProject } = require("../helpers");
const { generateWeeklyReport, weekRange, parseYmd } = require("../weekly");
const { resolveLlmConfig } = require("../llm");

module.exports = function reportsRouter(pool, env) {
  const r = express.Router();

  /* 前端用来提示「AI 已就绪 / 未配置模型」（只回模型名，不回密钥任何片段） */
  r.get("/config", async (req, res, next) => {
    try {
      const cfg = await resolveLlmConfig(pool, env);
      res.json({
        llm: cfg.ready, model: cfg.ready ? cfg.model : "",
        source: cfg.source,
      });
    } catch (e) { next(e); }
  });

  /* 周报历史（可按项目过滤） */
  r.get("/", async (req, res, next) => {
    try {
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      const params = [ids];
      let sql = `SELECT w.id, w.project_id, w.week_start, w.week_end, w.source, w.model,
                        w.created_at, w.updated_at, p.name AS project_name
                 FROM weekly_reports w LEFT JOIN projects p ON w.project_id = p.id
                 WHERE w.project_id IN (?)`;
      if (req.query.project_id) { sql += " AND w.project_id=?"; params.push(Number(req.query.project_id)); }
      sql += " ORDER BY w.week_start DESC, w.id DESC LIMIT 60";
      const [rows] = await pool.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  });

  /* 生成/重新生成某项目某周的周报（同一周覆盖） */
  r.post("/generate", async (req, res, next) => {
    try {
      const projectId = Number(req.body && req.body.project_id);
      if (!projectId) return res.status(400).json({ error: "请选择项目" });
      const ws = req.body && req.body.week_start;
      if (ws && !parseYmd(ws)) return res.status(400).json({ error: "周起始日期格式应为 YYYY-MM-DD" });
      if (!(await canAccessProject(pool, req.session.user, projectId))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const out = await generateWeeklyReport(pool, env, projectId, ws, req.session.user.id);
      await pool.query(
        `INSERT INTO weekly_reports(project_id,week_start,week_end,content,source,model,created_by)
         VALUES(?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE content=VALUES(content), source=VALUES(source),
           model=VALUES(model), week_end=VALUES(week_end), created_by=VALUES(created_by), updated_at=NOW()`,
        [projectId, out.week_start, out.week_end, out.content, out.source, out.model || "", req.session.user.id]
      );
      const [[row]] = await pool.query(
        "SELECT id, updated_at FROM weekly_reports WHERE project_id=? AND week_start=?",
        [projectId, out.week_start]
      );
      res.json({
        id: row.id, project_id: projectId,
        week_start: out.week_start, week_end: out.week_end,
        content: out.content, source: out.source, model: out.model,
        warning: out.warning || "", updated_at: row.updated_at,
      });
    } catch (e) { next(e); }
  });

  /* 下载 Word（真正的 .docx，由已存的 Markdown 转换而来） */
  r.get("/:id/docx", async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT w.*, p.name AS project_name FROM weekly_reports w
         LEFT JOIN projects p ON w.project_id = p.id WHERE w.id=?`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: "周报不存在" });
      const w = rows[0];
      if (!(await canAccessProject(pool, req.session.user, w.project_id))) {
        return res.status(403).json({ error: "无权下载该周报" });
      }
      const { markdownToDocxBuffer, reportFileName, ensureTitle } = require("../docx");
      const content = ensureTitle(w.content, w.project_name, w.week_start, w.week_end);
      const buf = await markdownToDocxBuffer(content, {
        title: `${w.project_name || "项目"} 周报`,
        footer: "项目管理工作台",
      });
      const name = reportFileName(w.project_name, w.week_start, w.week_end);
      const ascii = `weekly-report-${w.week_start}.docx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
      );
      res.setHeader("Content-Length", buf.length);
      res.end(buf);
    } catch (e) { next(e); }
  });

  /* 单篇周报全文 */
  r.get("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM weekly_reports WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "周报不存在" });
      const w = rows[0];
      if (!(await canAccessProject(pool, req.session.user, w.project_id))) {
        return res.status(403).json({ error: "无权查看该周报" });
      }
      res.json(w);
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT id, project_id FROM weekly_reports WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "周报不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该周报" });
      }
      await pool.query("DELETE FROM weekly_reports WHERE id=?", [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
