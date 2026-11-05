const express = require("express");
const { validateUpdate } = require("../validate");
const { visibleProjectIds, canAccessProject } = require("../helpers");

/* 进度记录：模块当前进度 = 最新一条记录（update_date 降序，id 降序）
   写入/修改/删除后自动把 modules.progress 同步为最新记录值 */

async function syncModuleProgress(pool, moduleId) {
  const [rows] = await pool.query(
    "SELECT progress FROM module_updates WHERE module_id=? ORDER BY update_date DESC, id DESC LIMIT 1",
    [moduleId]
  );
  if (rows.length) {
    await pool.query("UPDATE modules SET progress=? WHERE id=?", [rows[0].progress, moduleId]);
  }
}

const updatesRouter = function (pool) {
  const r = express.Router();

  /* 列表：?project_id= 或 ?module_id=，均做可见性过滤 */
  r.get("/", async (req, res, next) => {
    try {
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      const { project_id, module_id } = req.query;
      let sql = "SELECT * FROM module_updates WHERE project_id IN (?)";
      const params = [ids];
      if (project_id) { sql += " AND project_id=?"; params.push(parseInt(project_id, 10)); }
      if (module_id)  { sql += " AND module_id=?";  params.push(parseInt(module_id, 10)); }
      sql += " ORDER BY update_date DESC, id DESC";
      const [rows] = await pool.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post("/", async (req, res, next) => {
    try {
      const module_id = parseInt(req.body && req.body.module_id, 10);
      const [mods] = await pool.query("SELECT id, project_id FROM modules WHERE id=?", [module_id]);
      if (!mods.length) return res.status(404).json({ error: "模块不存在" });
      if (!(await canAccessProject(pool, req.session.user, mods[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateUpdate(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const u = v.value;
      const [ins] = await pool.query(
        "INSERT INTO module_updates(module_id,project_id,update_date,progress,note,created_by) VALUES(?,?,?,?,?,?)",
        [module_id, mods[0].project_id, u.updateDate, u.progress, u.note, req.session.user.id]
      );
      await syncModuleProgress(pool, module_id);
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT id, module_id, project_id FROM module_updates WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "进度记录不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateUpdate(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const u = v.value;
      const [r2] = await pool.query(
        "UPDATE module_updates SET update_date=?, progress=?, note=? WHERE id=?",
        [u.updateDate, u.progress, u.note, req.params.id]
      );
      if (!r2.affectedRows) return res.status(404).json({ error: "进度记录不存在" });
      await syncModuleProgress(pool, rows[0].module_id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT id, module_id, project_id FROM module_updates WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "进度记录不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      await pool.query("DELETE FROM module_updates WHERE id=?", [req.params.id]);
      await syncModuleProgress(pool, rows[0].module_id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = updatesRouter;
module.exports.syncModuleProgress = syncModuleProgress;
