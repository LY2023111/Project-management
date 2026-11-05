/* WBS 阶段：项目 → 阶段 → 任务。阶段跟随项目可见性；编辑 = 管理员/项目负责人 */
const express = require("express");
const { validatePhase } = require("../validate");
const { canAccessProject } = require("../helpers");

module.exports = function phasesRouter(pool) {
  const r = express.Router();

  /* 列表：?project_id= 过滤，可见性过滤 */
  r.get("/", async (req, res, next) => {
    try {
      const { visibleProjectIds } = require("../helpers");
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      let sql = "SELECT * FROM phases WHERE project_id IN (?)";
      const params = [ids];
      const { project_id } = req.query;
      if (project_id) { sql += " AND project_id=?"; params.push(parseInt(project_id, 10)); }
      sql += " ORDER BY sort_order, id";
      const [rows] = await pool.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post("/", async (req, res, next) => {
    try {
      const project_id = parseInt(req.body && req.body.project_id, 10);
      if (!project_id) return res.status(400).json({ error: "所属项目必填" });
      if (!(await canAccessProject(pool, req.session.user, project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validatePhase(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const p = v.value;
      if (p.planStart && p.planEnd && p.planStart > p.planEnd) {
        return res.status(400).json({ error: "阶段计划开始不能晚于计划结束" });
      }
      if (!p.sortOrder) {
        const [[mx]] = await pool.query("SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM phases WHERE project_id=?", [project_id]);
        p.sortOrder = mx.n;
      }
      const [ins] = await pool.query(
        "INSERT INTO phases(project_id,name,plan_start,plan_end,status,sort_order,note) VALUES(?,?,?,?,?,?,?)",
        [project_id, p.name, p.planStart, p.planEnd, p.status, p.sortOrder, p.note]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM phases WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "阶段不存在" });
      const old = rows[0];
      if (!(await canAccessProject(pool, req.session.user, old.project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      /* 合并语义：未提交的字段保留旧值，避免 PUT 清空 */
      const v = validatePhase(Object.assign({}, old, req.body || {}));
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const p = v.value;
      if (p.planStart && p.planEnd && p.planStart > p.planEnd) {
        return res.status(400).json({ error: "阶段计划开始不能晚于计划结束" });
      }
      await pool.query(
        "UPDATE phases SET name=?,plan_start=?,plan_end=?,status=?,sort_order=?,note=? WHERE id=?",
        [p.name, p.planStart, p.planEnd, p.status, p.sortOrder, p.note, req.params.id]
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM phases WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "阶段不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      await pool.query("DELETE FROM phases WHERE id=?", [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
