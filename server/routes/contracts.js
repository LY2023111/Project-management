/* 合同管理：文件存磁盘（uploads/），元数据存 MySQL。仅上传/下载/删除，不做解析分析。 */
const fs = require("fs");
const express = require("express");
const { validateContract } = require("../validate");
const { visibleProjectIds, canAccessProject } = require("../helpers");
const { createUploader, uploadErrorHandler, fixFilename, removeStored, storedPath, ensureUploadDir } = require("../upload");

module.exports = function contractsRouter(pool) {
  const r = express.Router();
  ensureUploadDir();
  const upload = createUploader();

  /* 合同列表（仅可见项目的合同） */
  r.get("/", async (req, res, next) => {
    try {
      const ids = await visibleProjectIds(pool, req.session.user);
      if (!ids.length) return res.json([]);
      const [rows] = await pool.query(
        `SELECT c.*, p.name AS project_name, u.display_name AS uploader_name
         FROM contracts c
         LEFT JOIN projects p ON c.project_id = p.id
         LEFT JOIN users u ON c.uploaded_by = u.id
         WHERE c.project_id IN (?) ORDER BY c.id DESC`,
        [ids]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  /* 上传合同（multipart：file + 项目/名称等字段） */
  r.post("/", upload.single("file"), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "请选择合同文件" });
      const v = validateContract(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const c = v.value;
      if (!(await canAccessProject(pool, req.session.user, req.body.project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const [ins] = await pool.query(
        `INSERT INTO contracts(project_id,name,code,party,amount,sign_date,note,file_name,stored_name,file_size,file_mime,uploaded_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          Number(req.body.project_id), c.name, c.code, c.party,
          c.amount === undefined ? null : c.amount, c.sign_date, c.note,
          req.file.originalname.slice(0, 255) ? fixFilename(req.file.originalname).slice(0, 255) : "未命名文件", req.file.filename,
          req.file.size, req.file.mimetype || "", req.session.user.id,
        ]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) {
      // 入库失败时清理已落盘文件，避免残留
      if (req.file) removeStored(req.file.filename);
      next(e);
    }
  });

  /* 编辑合同元数据（不换文件） */
  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT id, project_id FROM contracts WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "合同不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateContract(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const c = v.value;
      await pool.query(
        "UPDATE contracts SET name=?,code=?,party=?,amount=?,sign_date=?,note=? WHERE id=?",
        [c.name, c.code, c.party, c.amount === undefined ? null : c.amount, c.sign_date, c.note, req.params.id]
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* 下载合同文件 */
  r.get("/:id/file", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM contracts WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "合同不存在" });
      const c = rows[0];
      if (!(await canAccessProject(pool, req.session.user, c.project_id))) {
        return res.status(403).json({ error: "无权下载该合同" });
      }
      const fp = storedPath(c.stored_name);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: "合同文件已丢失（磁盘上不存在）" });
      // 中文文件名用 RFC 5987 编码，兼容各浏览器
      res.setHeader("Content-Type", c.file_mime || "application/octet-stream");
      res.setHeader("Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(c.file_name));
      res.sendFile(fp);
    } catch (e) { next(e); }
  });

  /* 删除合同（同时删除磁盘文件） */
  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM contracts WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "合同不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      await pool.query("DELETE FROM contracts WHERE id=?", [req.params.id]);
      removeStored(rows[0].stored_name);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* multer 错误单独处理，返回可读提示 */
  r.use(uploadErrorHandler);

  return r;
};
