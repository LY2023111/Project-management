const express = require("express");
const { validateMilestone } = require("../validate");
const { visibleProjectIds, canAccessProject } = require("../helpers");

module.exports = function milestonesRouter(pool) {
  const r = express.Router();

  r.get("/", async (req, res, next) => {
    try {
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      const { project_id } = req.query;
      let sql = "SELECT * FROM milestones WHERE project_id IN (?)";
      const params = [ids];
      if (project_id) { sql += " AND project_id=?"; params.push(project_id); }
      sql += " ORDER BY sort_order, id";
      const [rows] = await pool.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post("/", async (req, res, next) => {
    try {
      const project_id = parseInt(req.body && req.body.project_id, 10);
      if (!(await canAccessProject(pool, req.session.user, project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateMilestone(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const m = v.value;
      const [p] = await pool.query("SELECT id FROM projects WHERE id=?", [project_id]);
      if (!p.length) return res.status(400).json({ error: "所属项目不存在" });
      const [ins] = await pool.query(
        "INSERT INTO milestones(project_id,name,plan_date,actual_date,status,note,sort_order) VALUES(?,?,?,?,?,?,99)",
        [project_id, m.name, m.planDate, m.actualDate, m.status, m.note]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT project_id FROM milestones WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "里程碑不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateMilestone(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const m = v.value;
      const [r2] = await pool.query(
        "UPDATE milestones SET name=?,plan_date=?,actual_date=?,status=?,note=? WHERE id=?",
        [m.name, m.planDate, m.actualDate, m.status, m.note, req.params.id]
      );
      if (!r2.affectedRows) return res.status(404).json({ error: "里程碑不存在" });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT project_id FROM milestones WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "里程碑不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const [r2] = await pool.query("DELETE FROM milestones WHERE id=?", [req.params.id]);
      if (!r2.affectedRows) return res.status(404).json({ error: "里程碑不存在" });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
