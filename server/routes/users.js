const express = require("express");
const { hashPassword } = require("../auth");

module.exports = function usersRouter(pool) {
  const r = express.Router();

  r.get("/", async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        "SELECT id, username, display_name, role, created_at FROM users ORDER BY id"
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post("/", async (req, res, next) => {
    try {
      const username = String(req.body.username || "").trim();
      const password = String(req.body.password || "");
      const display_name = String(req.body.display_name || "").trim();
      const role = req.body.role === "admin" ? "admin" : "user";
      if (!/^[a-zA-Z0-9_\-]{2,50}$/.test(username)) {
        return res.status(400).json({ error: "用户名须为 2-50 位字母/数字/下划线/中横线" });
      }
      if (password.length < 4) return res.status(400).json({ error: "密码至少 4 位" });
      if (display_name.length > 50) return res.status(400).json({ error: "姓名不能超过 50 字" });
      const [dup] = await pool.query("SELECT id FROM users WHERE username=?", [username]);
      if (dup.length) return res.status(400).json({ error: "用户名已存在" });
      const [ins] = await pool.query(
        "INSERT INTO users(username,password_hash,display_name,role) VALUES(?,?,?,?)",
        [username, hashPassword(password), display_name, role]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  r.put("/:id", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const [rows] = await pool.query("SELECT * FROM users WHERE id=?", [id]);
      if (!rows.length) return res.status(404).json({ error: "用户不存在" });
      const target = rows[0];

      const display_name = req.body.display_name !== undefined
        ? String(req.body.display_name).trim().slice(0, 50) : target.display_name;
      const role = req.body.role !== undefined ? (req.body.role === "admin" ? "admin" : "user") : target.role;

      // 不能把最后一个管理员降级
      if (target.role === "admin" && role !== "admin") {
        const [admins] = await pool.query("SELECT COUNT(*) n FROM users WHERE role='admin'");
        if (admins[0].n <= 1) return res.status(400).json({ error: "不能降级最后一个管理员" });
      }
      if (req.body.password !== undefined && req.body.password !== "") {
        const pw = String(req.body.password);
        if (pw.length < 4) return res.status(400).json({ error: "密码至少 4 位" });
        await pool.query("UPDATE users SET display_name=?,role=?,password_hash=? WHERE id=?",
          [display_name, role, hashPassword(pw), id]);
      } else {
        await pool.query("UPDATE users SET display_name=?,role=? WHERE id=?", [display_name, role, id]);
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (id === req.session.user.id) return res.status(400).json({ error: "不能删除自己" });
      const [rows] = await pool.query("SELECT * FROM users WHERE id=?", [id]);
      if (!rows.length) return res.status(404).json({ error: "用户不存在" });
      if (rows[0].role === "admin") {
        const [admins] = await pool.query("SELECT COUNT(*) n FROM users WHERE role='admin'");
        if (admins[0].n <= 1) return res.status(400).json({ error: "不能删除最后一个管理员" });
      }
      await pool.query("DELETE FROM users WHERE id=?", [id]);
      res.json({ ok: true }); // 其创建的项目保留，created_by 置空（转为仅管理员可见）
    } catch (e) { next(e); }
  });

  return r;
};
