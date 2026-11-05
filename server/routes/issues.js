const express = require("express");
const { validateIssue } = require("../validate");
const { visibleProjectIds, canAccessProject } = require("../helpers");

/* 问题/需求流转：
   待处理 → 处理中 → 已完成（处理人提交完成状况）→ 已解决（提交人测试通过）
   已完成 可被退回 处理中（测试不通过） */

module.exports = function issuesRouter(pool) {
  const r = express.Router();

  /* 筛选：project_id / type / status；可见 = 可见项目 ∪ 指派给我的 ∪ 我提交的 */
  r.get("/", async (req, res, next) => {
    try {
      const me = req.session.user;
      const ids = await visibleProjectIds(pool, me);
      const { project_id, type, status } = req.query;
      const where = ["(i.project_id IN (?) OR i.assignee_id=? OR i.reporter_id=?)"];
      const params = [ids.length ? ids : [-1], me.id, me.id];
      if (project_id) { where.push("i.project_id=?"); params.push(project_id); }
      if (type)       { where.push("i.type=?"); params.push(type); }
      if (status)     { where.push("i.status=?"); params.push(status); }
      const sql = `SELECT i.*, ru.display_name AS reporter_name, au.display_name AS assignee_name
        FROM issues i LEFT JOIN users ru ON i.reporter_id=ru.id LEFT JOIN users au ON i.assignee_id=au.id
        WHERE ` + where.join(" AND ") + " ORDER BY i.id DESC";
      const [rows] = await pool.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  });

  /* 校验指派用户存在；返回其展示名 */
  async function resolveAssignee(assigneeId) {
    if (!assigneeId) return { id: null, label: null };
    const [rows] = await pool.query("SELECT username, display_name FROM users WHERE id=?", [assigneeId]);
    if (!rows.length) return { invalid: true };
    const u = rows[0];
    return { id: assigneeId, label: u.display_name || u.username };
  }

  r.post("/", async (req, res, next) => {
    try {
      const project_id = parseInt(req.body && req.body.project_id, 10);
      if (!(await canAccessProject(pool, req.session.user, project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateIssue(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const i = v.value;
      const module_id = req.body.module_id ? parseInt(req.body.module_id, 10) : null;
      const [p] = await pool.query("SELECT id FROM projects WHERE id=?", [project_id]);
      if (!p.length) return res.status(400).json({ error: "所属项目不存在" });
      if (module_id) {
        const [m] = await pool.query("SELECT id FROM modules WHERE id=? AND project_id=?", [module_id, project_id]);
        if (!m.length) return res.status(400).json({ error: "关联模块不属于该项目" });
      }
      const asg = await resolveAssignee(i.assigneeId);
      if (asg.invalid) return res.status(400).json({ error: "指派的用户不存在" });
      const owner = i.owner || asg.label || "";
      const [ins] = await pool.query(
        `INSERT INTO issues(project_id,module_id,type,title,detail,owner,priority,status,
         assignee_id,reporter_id,plan_date,actual_date,actual_hours,finish_note,resolved_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [project_id, module_id, i.type, i.title, i.detail, owner, i.priority, i.status,
         asg.id, req.session.user.id, i.planDate, i.actualDate, i.actualHours, i.finishNote,
         i.status === "已解决" ? new Date() : null]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM issues WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "记录不存在" });
      const old = rows[0];
      const me = req.session.user;
      const ids = await visibleProjectIds(pool, me);
      const mineInvolved = old.assignee_id === me.id || old.reporter_id === me.id;
      if (!ids.includes(old.project_id) && !mineInvolved) {
        return res.status(403).json({ error: "无权操作该记录" });
      }
      /* 与旧记录合并：请求体未提供的字段保持原值，避免部分提交清空指派/日期/工时 */
      const merged = Object.assign({}, old, req.body || {});
      const v = validateIssue(merged);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const i = v.value;
      const module_id = req.body.module_id !== undefined
        ? (req.body.module_id ? parseInt(req.body.module_id, 10) : null) : old.module_id;

      /* 流转规则 */
      const FLOW = {
        "待处理": ["处理中", "已完成", "已解决"],
        "处理中": ["已完成", "已解决", "待处理"],
        "已完成": ["已解决", "处理中"],   // 测试通过 → 已解决；不通过 → 退回处理中
        "已解决": ["已解决"],             // 终态（仍允许编辑其他字段）
      };
      if (old.status !== i.status && !FLOW[old.status].includes(i.status)) {
        return res.status(400).json({ error: `状态不允许从「${old.status}」改为「${i.status}」` });
      }
      /* 提交已完成：必须填写完成状况，实际完成时间缺省今天 */
      if (i.status === "已完成" && old.status !== "已完成") {
        if (!i.finishNote) return res.status(400).json({ error: "提交「已完成」时必须填写完成状况" });
        if (!i.actualDate) i.actualDate = new Date().toISOString().slice(0, 10);
      }
      const asg = await resolveAssignee(i.assigneeId);
      if (asg.invalid) return res.status(400).json({ error: "指派的用户不存在" });
      const owner = i.owner || asg.label || "";

      let resolvedAt;
      if (i.status === "已解决" && old.status !== "已解决") resolvedAt = new Date();
      else if (i.status !== "已解决") resolvedAt = null;
      else resolvedAt = old.resolved_at;

      const [r2] = await pool.query(
        `UPDATE issues SET type=?,title=?,detail=?,owner=?,priority=?,status=?,module_id=?,
         assignee_id=?,plan_date=?,actual_date=?,actual_hours=?,finish_note=?,resolved_at=? WHERE id=?`,
        [i.type, i.title, i.detail, owner, i.priority, i.status, module_id,
         asg.id, i.planDate, i.actualDate, i.actualHours, i.finishNote, resolvedAt, req.params.id]
      );
      if (!r2.affectedRows) return res.status(404).json({ error: "记录不存在" });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT project_id FROM issues WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "记录不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const [r2] = await pool.query("DELETE FROM issues WHERE id=?", [req.params.id]);
      if (!r2.affectedRows) return res.status(404).json({ error: "记录不存在" });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
