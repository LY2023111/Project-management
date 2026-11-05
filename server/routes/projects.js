const express = require("express");
const { validateProject } = require("../validate");
const { visibleProjectIds, canAccessProject } = require("../helpers");
const { MS_TYPES } = require("../constants");
const { removeStored } = require("../upload");

module.exports = function projectsRouter(pool) {
  const r = express.Router();

  /* 只返回当前用户可见的项目 */
  r.get("/", async (req, res, next) => {
    try {
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      const [rows] = await pool.query("SELECT * FROM projects WHERE id IN (?) ORDER BY id DESC", [ids]);
      res.json(rows);
    } catch (e) { next(e); }
  });

  /* 创建项目：事务内同时生成 部署/测试/培训/上线/验收 五个里程碑；登记人=当前用户 */
  r.post("/", async (req, res, next) => {
    const v = validateProject(req.body);
    if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
    const p = v.value;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [ins] = await conn.query(
        "INSERT INTO projects(name,code,owner,status,note,created_by) VALUES(?,?,?,?,?,?)",
        [p.name, p.code, p.owner, p.status, p.note, req.session.user.id]
      );
      const pid = ins.insertId;
      await conn.query(
        "INSERT INTO milestones(project_id,name,status,sort_order) VALUES ?",
        [MS_TYPES.map((n, i) => [pid, n, "未开始", i])]
      );
      await conn.commit();
      res.status(201).json({ id: pid });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally { conn.release(); }
  });

  r.put("/:id", async (req, res, next) => {
    if (!(await canAccessProject(pool, req.session.user, req.params.id))) {
      return res.status(403).json({ error: "无权操作该项目" });
    }
    const v = validateProject(req.body);
    if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
    const p = v.value;
    try {
      const [r2] = await pool.query(
        "UPDATE projects SET name=?,code=?,owner=?,status=?,note=? WHERE id=?",
        [p.name, p.code, p.owner, p.status, p.note, req.params.id]
      );
      if (!r2.affectedRows) return res.status(404).json({ error: "项目不存在" });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    if (!(await canAccessProject(pool, req.session.user, req.params.id))) {
      return res.status(403).json({ error: "无权操作该项目" });
    }
    try {
      /* 级联删除前先记下磁盘文件名，删库后一并清理，避免孤儿文件 */
      const [attachments] = await pool.query(
        "SELECT stored_name FROM module_files WHERE project_id=?", [req.params.id]);
      const [contractFiles] = await pool.query(
        "SELECT stored_name FROM contracts WHERE project_id=?", [req.params.id]);
      const [r2] = await pool.query("DELETE FROM projects WHERE id=?", [req.params.id]);
      if (!r2.affectedRows) return res.status(404).json({ error: "项目不存在" });
      attachments.forEach(x => removeStored(x.stored_name));
      contractFiles.forEach(x => removeStored(x.stored_name));
      res.json({ ok: true }); // 模块/里程碑/记录/附件由外键级联删除
    } catch (e) { next(e); }
  });

  return r;
};
