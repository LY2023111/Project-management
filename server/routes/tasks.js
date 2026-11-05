/* WBS 任务：CRUD、前置依赖校验（同项目 + 防环）、状态↔进度联动、
   三级权限（管理员/项目负责人全量；任务负责人本人限改执行字段）、模块进度重算、模板套用 */
const express = require("express");
const { validateTask } = require("../validate");
const { visibleProjectIds, canAccessProject } = require("../helpers");
const { detectCycle, calcModuleProgress, expandTemplate, TEMPLATES } = require("../wbs");

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 任务负责人本人可改的字段（不能动计划、归属、依赖） */
const SELF_FIELDS = ["status", "progress", "actual_start", "actual_end", "actual_hours", "note"];

/* 模块进度重算：仅当模块进度来源为 wbs */
async function recalcModuleWbs(pool, moduleId) {
  if (!moduleId) return;
  const [[m]] = await pool.query("SELECT id, progress_source FROM modules WHERE id=?", [moduleId]);
  if (!m || m.progress_source !== "wbs") return;
  const [ts] = await pool.query("SELECT estimate_hours, progress, status FROM tasks WHERE module_id=?", [moduleId]);
  const p = calcModuleProgress(ts);
  if (p != null) await pool.query("UPDATE modules SET progress=? WHERE id=?", [p, moduleId]);
}

function tasksRouterFactory(pool) {
  const r = tasksRouterFactoryInner(pool);
  r.recalcModuleWbs = recalcModuleWbs;
  r.today = today;
  return r;
}

function tasksRouterFactoryInner(pool) {
  const r = express.Router();

  /* 任务列表：?project_id= / ?mine=1；可见 = 项目可见 ∪ 负责人是我 */
  r.get("/", async (req, res, next) => {
    try {
      const me = req.session.user;
      const ids = await visibleProjectIds(pool, me);
      const { project_id, mine } = req.query;
      let sql = `SELECT t.*, p.name AS project_name, m.name AS module_name,
                        u.display_name AS owner_name, pd.name AS predecessor_name,
                        ph.name AS phase_name
                 FROM tasks t
                 LEFT JOIN projects p ON t.project_id=p.id
                 LEFT JOIN modules m ON t.module_id=m.id
                 LEFT JOIN users u ON t.owner_id=u.id
                 LEFT JOIN tasks pd ON t.predecessor_id=pd.id
                 LEFT JOIN phases ph ON t.phase_id=ph.id
                 WHERE 1=1`;
      const params = [];
      if (mine === "1") {
        sql += " AND t.owner_id=?";
        params.push(me.id);
      } else if (project_id) {
        const pid = parseInt(project_id, 10);
        if (!ids.includes(pid)) {
          /* 无项目可见性时仍能看到自己负责的任务（与「指派给我」口径一致） */
          sql += " AND t.project_id=? AND t.owner_id=?";
          params.push(pid, me.id);
        } else {
          sql += " AND t.project_id=?";
          params.push(pid);
        }
      } else {
        sql += ids.length ? " AND (t.project_id IN (?) OR t.owner_id=?)" : " AND t.owner_id=?";
        if (ids.length) params.push(ids, me.id); else params.push(me.id);
      }
      sql += " ORDER BY t.phase_id, t.sort_order, t.id";
      const [rows] = await pool.query(sql, params);
      res.json(rows);
    } catch (e) { next(e); }
  });

  /* 我的任务（快捷入口）：负责人=我，按计划结束升序，附逾期/临期标记 */
  r.get("/my", async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT t.*, p.name AS project_name, m.name AS module_name,
                u.display_name AS owner_name, pd.name AS predecessor_name
         FROM tasks t
         LEFT JOIN projects p ON t.project_id=p.id
         LEFT JOIN modules m ON t.module_id=m.id
         LEFT JOIN users u ON t.owner_id=u.id
         LEFT JOIN tasks pd ON t.predecessor_id=pd.id
         WHERE t.owner_id=? AND t.status NOT IN ('已完成','已取消')
         ORDER BY (t.plan_end IS NULL), t.plan_end, t.id`,
        [req.session.user.id]
      );
      const td = today();
      res.json(rows.map((t) => ({
        ...t,
        is_late: !!(t.plan_end && t.plan_end < td && t.status !== "已完成" && t.status !== "已取消"),
        due_in_days: t.plan_end ? Math.ceil((new Date(t.plan_end) - new Date(td)) / 86400000) : null,
      })));
    } catch (e) { next(e); }
  });

  /* 模板清单 */
  r.get("/templates", (req, res) => {
    res.json(Object.values(TEMPLATES).map((t) => ({ key: t.key, name: t.name, items: t.items })));
  });

  /* 新建任务 */
  r.post("/", async (req, res, next) => {
    try {
      const project_id = parseInt(req.body && req.body.project_id, 10);
      if (!(await canAccessProject(pool, req.session.user, project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const v = validateTask(req.body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const t = v.value;
      if (!t.phaseId) return res.status(400).json({ error: "所属阶段必填" });
      const [[ph]] = await pool.query("SELECT id, project_id FROM phases WHERE id=?", [t.phaseId]);
      if (!ph || ph.project_id !== project_id) return res.status(400).json({ error: "所属阶段不存在或不属于该项目" });
      if (t.moduleId) {
        const [[m]] = await pool.query("SELECT id, project_id FROM modules WHERE id=?", [t.moduleId]);
        if (!m || m.project_id !== project_id) return res.status(400).json({ error: "关联模块不存在或不属于该项目" });
      }
      if (t.ownerId) {
        const [[u]] = await pool.query("SELECT id FROM users WHERE id=?", [t.ownerId]);
        if (!u) return res.status(400).json({ error: "负责人用户不存在" });
      }
      if (t.planStart && t.planEnd && t.planStart > t.planEnd) {
        return res.status(400).json({ error: "计划开始不能晚于计划结束" });
      }
      if (t.predecessorId) {
        const [[pd]] = await pool.query("SELECT id, project_id FROM tasks WHERE id=?", [t.predecessorId]);
        if (!pd || pd.project_id !== project_id) return res.status(400).json({ error: "前置任务不存在或不属于该项目" });
      }
      if (!t.sortOrder) {
        const [[mx]] = await pool.query("SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM tasks WHERE phase_id=?", [t.phaseId]);
        t.sortOrder = mx.n;
      }
      const [ins] = await pool.query(
        `INSERT INTO tasks(project_id,phase_id,module_id,name,owner_id,plan_start,plan_end,actual_start,actual_end,
                           estimate_hours,actual_hours,status,progress,predecessor_id,sort_order,note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [project_id, t.phaseId, t.moduleId, t.name, t.ownerId, t.planStart, t.planEnd, t.actualStart, t.actualEnd,
         t.estimateHours, t.actualHours, t.status, t.progress, t.predecessorId, t.sortOrder, t.note]
      );
      await recalcModuleWbs(pool, t.moduleId);
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  /* 更新任务（合并语义；三级权限） */
  r.put("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM tasks WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "任务不存在" });
      const old = rows[0];
      const me = req.session.user;
      const full = await canAccessProject(pool, me, old.project_id);
      const isSelf = Number(old.owner_id) === Number(me.id);
      if (!full && !isSelf) return res.status(403).json({ error: "无权操作该任务" });

      const body = req.body || {};
      /* 任务负责人本人：只允许执行字段，出现其他字段直接 403 */
      if (!full) {
        const attempted = Object.keys(body).filter((k) => !SELF_FIELDS.includes(k));
        if (attempted.length) {
          return res.status(403).json({ error: "任务负责人只能修改状态、进度、实际时间、实际工时和备注" });
        }
      }

      const merged = Object.assign({}, old, body);
      const v = validateTask(merged);
      if (!v.ok) return res.status(400).json({ error: v.errors.join("；") });
      const t = v.value;

      /* 归属与依赖校验（仅全量权限者会改到） */
      if (t.phaseId !== old.phase_id) {
        const [[ph]] = await pool.query("SELECT id, project_id FROM phases WHERE id=?", [t.phaseId]);
        if (!ph || ph.project_id !== old.project_id) return res.status(400).json({ error: "所属阶段不存在或不属于该项目" });
      }
      if (t.moduleId && t.moduleId !== old.module_id) {
        const [[m]] = await pool.query("SELECT id, project_id FROM modules WHERE id=?", [t.moduleId]);
        if (!m || m.project_id !== old.project_id) return res.status(400).json({ error: "关联模块不存在或不属于该项目" });
      }
      if (t.planStart && t.planEnd && t.planStart > t.planEnd) {
        return res.status(400).json({ error: "计划开始不能晚于计划结束" });
      }
      if (t.predecessorId !== old.predecessor_id) {
        if (t.predecessorId) {
          if (Number(t.predecessorId) === Number(old.id)) return res.status(400).json({ error: "前置任务不能是自己" });
          const [pts] = await pool.query("SELECT id, predecessor_id FROM tasks WHERE project_id=?", [old.project_id]);
          const [[pd]] = await pool.query("SELECT id, project_id FROM tasks WHERE id=?", [t.predecessorId]);
          if (!pd || pd.project_id !== old.project_id) return res.status(400).json({ error: "前置任务不存在或不属于该项目" });
          if (detectCycle(pts, old.id, t.predecessorId)) {
            return res.status(400).json({ error: "不能选择自己的下游任务作为前置（会形成循环依赖）" });
          }
        }
      }

      /* 状态↔进度联动 */
      let status = t.status, progress = t.progress;
      if (status === "已完成") {
        progress = 100;
        if (!t.actualEnd) t.actualEnd = today();
      } else if (progress === 100 && status !== "已取消") {
        status = "已完成";
        if (!t.actualEnd) t.actualEnd = today();
      }

      await pool.query(
        `UPDATE tasks SET phase_id=?,module_id=?,name=?,owner_id=?,plan_start=?,plan_end=?,actual_start=?,actual_end=?,
                          estimate_hours=?,actual_hours=?,status=?,progress=?,predecessor_id=?,sort_order=?,note=?
         WHERE id=?`,
        [t.phaseId, t.moduleId, t.name, t.ownerId, t.planStart, t.planEnd, t.actualStart, t.actualEnd,
         t.estimateHours, t.actualHours, status, progress, t.predecessorId, t.sortOrder, t.note, old.id]
      );
      await recalcModuleWbs(pool, old.module_id);
      if (t.moduleId !== old.module_id) await recalcModuleWbs(pool, t.moduleId);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete("/:id", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM tasks WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "任务不存在" });
      if (!(await canAccessProject(pool, req.session.user, rows[0].project_id))) {
        return res.status(403).json({ error: "无权操作该任务" });
      }
      await pool.query("UPDATE tasks SET predecessor_id=NULL WHERE predecessor_id=?", [rows[0].id]);
      await pool.query("DELETE FROM tasks WHERE id=?", [rows[0].id]);
      await recalcModuleWbs(pool, rows[0].module_id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* 套用 WBS 模板：body {module_id, template_key, launch_date?, buffer_days?, phase_id?, phase_name?} */
  r.post("/apply-template", async (req, res, next) => {
    try {
      const b = req.body || {};
      const module_id = parseInt(b.module_id, 10);
      const [[m]] = await pool.query("SELECT * FROM modules WHERE id=?", [module_id]);
      if (!m) return res.status(404).json({ error: "模块不存在" });
      if (!(await canAccessProject(pool, req.session.user, m.project_id))) {
        return res.status(403).json({ error: "无权操作该项目" });
      }
      const tpl = TEMPLATES[String(b.template_key || "")];
      if (!tpl) return res.status(400).json({ error: "模板不存在" });
      const launch = b.launch_date || (m.plan_date && String(m.plan_date).slice(0, 10));
      if (!launch) return res.status(400).json({ error: "请填写模块上线日期（模板按上线日倒排）" });

      /* 目标阶段：指定 phase_id 则校验归属，否则自动建「实施」阶段 */
      let phaseId = parseInt(b.phase_id, 10) || null;
      if (phaseId) {
        const [[ph]] = await pool.query("SELECT id, project_id FROM phases WHERE id=?", [phaseId]);
        if (!ph || ph.project_id !== m.project_id) return res.status(400).json({ error: "目标阶段不存在或不属于该项目" });
      } else {
        const phaseName = String(b.phase_name || "实施").slice(0, 100);
        const [[mx]] = await pool.query("SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM phases WHERE project_id=?", [m.project_id]);
        const [ins] = await pool.query(
          "INSERT INTO phases(project_id,name,sort_order,note) VALUES(?,?,?,?)",
          [m.project_id, phaseName, mx.n, "WBS 模板自动创建"]
        );
        phaseId = ins.insertId;
      }

      const items = expandTemplate(tpl, launch, b.buffer_days || 0);
      let n = 0, sort = 10, prevId = null;
      for (const it of items) {
        const [ins] = await pool.query(
          `INSERT INTO tasks(project_id,phase_id,module_id,name,plan_start,plan_end,status,progress,predecessor_id,sort_order)
           VALUES(?,?,?,?,?,?, '未开始', 0, ?, ?)`,
          [m.project_id, phaseId, module_id, it.name, it.plan_start, it.plan_end, prevId, sort]
        );
        prevId = ins.insertId; /* 模板任务按顺序串成前置链 */
        sort += 10; n++;
      }
      await recalcModuleWbs(pool, module_id);
      res.status(201).json({ created: n, phase_id: phaseId, template: tpl.name });
    } catch (e) { next(e); }
  });

  return r;
}

/* 供 modules 路由复用：切换进度来源后重算 */
module.exports = tasksRouterFactory;
module.exports.recalcModuleWbs = recalcModuleWbs;
module.exports.today = today;
