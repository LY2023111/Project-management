/* 模块附件：培训签到单 / 上线确认单 / 模块验收报告等交付材料。
   文件落磁盘 uploads/，元数据入 module_files；下载/删除均按项目可见性鉴权。 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const { FILE_CATEGORIES } = require("../constants");
const { visibleProjectIds, canAccessProject } = require("../helpers");
const { createUploader, uploadErrorHandler, fixFilename, removeStored, storedPath } = require("../upload");

const MAX_FILES = 10; // 单次最多上传 10 个附件

module.exports = function moduleFilesRouter(pool) {
  const r = express.Router();
  const upload = createUploader();

  /* 附件列表：?module_id= / ?project_id= / ?category=，仅返回可见项目 */
  r.get("/", async (req, res, next) => {
    try {
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      const where = ["f.project_id IN (?)"];
      const params = [ids];
      if (req.query.module_id) { where.push("f.module_id=?"); params.push(parseInt(req.query.module_id, 10)); }
      if (req.query.project_id) { where.push("f.project_id=?"); params.push(parseInt(req.query.project_id, 10)); }
      if (req.query.category) { where.push("f.category=?"); params.push(String(req.query.category)); }
      const [rows] = await pool.query(
        `SELECT f.*, m.name AS module_name, p.name AS project_name, u.display_name AS uploader_name
         FROM module_files f
         LEFT JOIN modules m ON f.module_id = m.id
         LEFT JOIN projects p ON f.project_id = p.id
         LEFT JOIN users u ON f.uploaded_by = u.id
         WHERE ${where.join(" AND ")}
         ORDER BY f.id DESC`,
        params
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  /* 上传附件（multipart：files 可多选 + module_id/category/note） */
  r.post("/", upload.array("files", MAX_FILES), async (req, res, next) => {
    const files = req.files || [];
    let keep = false; // 只有真正入库成功才保留磁盘文件
    try {
      const mid = parseInt(req.body && req.body.module_id, 10);
      if (!mid) return res.status(400).json({ error: "请指定所属模块" });
      if (!files.length) return res.status(400).json({ error: "请选择要上传的附件" });
      const category = String((req.body && req.body.category) || "其他").trim();
      if (!FILE_CATEGORIES.includes(category)) return res.status(400).json({ error: "附件类型不合法" });
      const note = String((req.body && req.body.note) || "").trim().slice(0, 500);
      const title = String((req.body && req.body.title) || "").trim().slice(0, 200);

      const [mods] = await pool.query("SELECT id, project_id FROM modules WHERE id=?", [mid]);
      if (!mods.length) return res.status(404).json({ error: "模块不存在" });
      const pid = mods[0].project_id;
      if (!(await canAccessProject(pool, req.session.user, pid))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }

      const tuples = [];
      const params = [];
      for (const f of files) {
        const name = (fixFilename(f.originalname) || "未命名文件").slice(0, 255);
        tuples.push("(?,?,?,?,?,?,?,?,?,?)");
        params.push(mid, pid, category, title, note, name, f.filename, f.size, f.mimetype || "", req.session.user.id);
      }
      const [ins] = await pool.query(
        `INSERT INTO module_files(module_id,project_id,category,title,note,file_name,stored_name,file_size,file_mime,uploaded_by)
         VALUES ${tuples.join(",")}`,
        params
      );
      keep = true;
      const first = ins.insertId;
      res.status(201).json({ ok: true, count: files.length, ids: files.map((_, i) => first + i) });
    } catch (e) {
      next(e);
    } finally {
      // 校验失败/入库失败时清理已落盘文件，避免孤儿文件占空间
      if (!keep) files.forEach(f => removeStored(f.filename));
    }
  });

  /* 下载附件 */
  r.get("/:id/file", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM module_files WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "附件不存在" });
      const f = rows[0];
      if (!(await canAccessProject(pool, req.session.user, f.project_id))) {
        return res.status(403).json({ error: "无权下载该附件" });
      }
      const fp = storedPath(f.stored_name);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: "附件文件已丢失（磁盘上不存在）" });
      res.setHeader("Content-Type", f.file_mime || "application/octet-stream");
      // 中文文件名用 RFC 5987 编码
      res.setHeader("Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(f.file_name)));
      res.sendFile(fp);
    } catch (e) { next(e); }
  });

  /* 修改附件类型/说明（不换文件） */
  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM module_files WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "附件不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const body = req.body || {};
      const category = body.category === undefined ? rows[0].category : String(body.category).trim();
      if (!FILE_CATEGORIES.includes(category)) return res.status(400).json({ error: "附件类型不合法" });
      const note = body.note === undefined ? rows[0].note : String(body.note).trim().slice(0, 500);
      const title = body.title === undefined ? rows[0].title : String(body.title).trim().slice(0, 200);
      await pool.query("UPDATE module_files SET category=?, title=?, note=? WHERE id=?",
        [category, title, note, req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* 删除附件（同时删除磁盘文件） */
  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM module_files WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "附件不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      await pool.query("DELETE FROM module_files WHERE id=?", [req.params.id]);
      removeStored(rows[0].stored_name);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.use(uploadErrorHandler);
  return r;
};
