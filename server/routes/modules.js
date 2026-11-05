const express = require("express");
const { validateModule } = require("../validate");
const { visibleProjectIds, canAccessProject } = require("../helpers");
const { removeStored } = require("../upload");

module.exports = function modulesRouter(pool) {
  const r = express.Router();

  r.get("/", async (req, res, next) => {
    try {
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      const { project_id } = req.query;
      let sql = "SELECT * FROM modules WHERE project_id IN (?)";
      const params = [ids];
      if (project_id) { sql += " AND project_id=?"; params.push(project_id); }
      sql += " ORDER BY id";
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
      const v = validateModule(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const m = v.value;
      const [p] = await pool.query("SELECT id FROM projects WHERE id=?", [project_id]);
      if (!p.length) return res.status(400).json({ error: "所属项目不存在" });
      const [ins] = await pool.query(
        "INSERT INTO modules(project_id,name,owner,plan_start,plan_date,actual_date,status,progress,progress_source,fail_reason,coord_note,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        [project_id, m.name, m.owner, m.planStart, m.planDate, m.actualDate, m.status, m.progress, m.progressSource, m.failReason, m.coordNote, m.note]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT project_id FROM modules WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "模块不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateModule(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const m = v.value;
      /* 进度来源：未提交则保留原值；manual 手动 / wbs 按 WBS 任务加权自动 */
      const [[cur]] = await pool.query("SELECT progress_source FROM modules WHERE id=?", [req.params.id]);
      const ps = req.body && req.body.progress_source !== undefined
        ? (req.body.progress_source === "wbs" ? "wbs" : "manual")
        : ((cur && cur.progress_source) || "manual");
      const [r2] = await pool.query(
        "UPDATE modules SET name=?,owner=?,plan_start=?,plan_date=?,actual_date=?,status=?,progress=?,progress_source=?,fail_reason=?,coord_note=?,note=? WHERE id=?",
        [m.name, m.owner, m.planStart, m.planDate, m.actualDate, m.status, m.progress, ps, m.failReason, m.coordNote, m.note, req.params.id]
      );
      if (!r2.affectedRows) return res.status(404).json({ error: "模块不存在" });
      if (ps === "wbs") {
        const tasksRouter = require("./tasks");
        await tasksRouter.recalcModuleWbs(pool, parseInt(req.params.id, 10));
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT project_id FROM modules WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "模块不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const [files] = await pool.query(
        "SELECT stored_name FROM module_files WHERE module_id=?", [req.params.id]);
      const [r2] = await pool.query("DELETE FROM modules WHERE id=?", [req.params.id]);
      if (!r2.affectedRows) return res.status(404).json({ error: "模块不存在" });
      files.forEach(x => removeStored(x.stored_name));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
