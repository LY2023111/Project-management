const path = require("path");
const express = require("express");
const session = require("express-session");
const { authenticateUser, authRequired, requireAdmin } = require("./auth");
const { visibleProjectIds } = require("./helpers");

/* 应用工厂：传入连接池即可创建 app，便于集成测试 */
function createApp(pool, env) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(session({
    name: "pmwb.sid",
    secret: env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000 },
  }));

  // ---- 认证（查 users 表）----
  app.post("/api/login", async (req, res, next) => {
    try {
      const user = await authenticateUser(pool, req.body && req.body.username, req.body && req.body.password);
      if (!user) return res.status(401).json({ error: "用户名或密码错误" });
      req.session.user = user;
      res.json({ ok: true, user });
    } catch (e) { next(e); }
  });
  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });
  app.get("/api/me", (req, res) => {
    if (req.session && req.session.user && req.session.user.id != null) {
      return res.json({ user: req.session.user });
    }
    res.status(401).json({ error: "未登录" });
  });

  // ---- 可指派用户（所有登录用户可选，用于问题指派）----
  app.get("/api/assignees", authRequired, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        "SELECT id, username, display_name, role FROM users ORDER BY role DESC, username"
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  // ---- 用户管理（仅管理员）----
  app.use("/api/users", authRequired, requireAdmin, require("./routes/users")(pool));

  // ---- 系统设置（仅管理员）：大模型密钥加密存储 ----
  app.use("/api/settings", authRequired, requireAdmin, require("./routes/settings")(pool, env));

  // ---- 业务接口（需登录，按可见性过滤）----
  app.use("/api/projects", authRequired, require("./routes/projects")(pool));
  app.use("/api/modules", authRequired, require("./routes/modules")(pool));
  app.use("/api/milestones", authRequired, require("./routes/milestones")(pool));
  app.use("/api/issues", authRequired, require("./routes/issues")(pool));
  app.use("/api/updates", authRequired, require("./routes/updates")(pool));
  app.use("/api/contracts", authRequired, require("./routes/contracts")(pool));
  app.use("/api/module-files", authRequired, require("./routes/moduleFiles")(pool));
  app.use("/api/reports", authRequired, require("./routes/reports")(pool, env));
  app.use("/api/phases", authRequired, require("./routes/phases")(pool));
  app.use("/api/tasks", authRequired, require("./routes/tasks")(pool));

  // 一次拉取全部数据（前端首屏，只含可见项目；额外包含 指派给我/我提交 的记录）
  app.get("/api/bootstrap", authRequired, async (req, res, next) => {
    try {
      const me = req.session.user;
      const ids = await visibleProjectIds(pool, me);
      const [projects, modules, milestones, issues, updates, contracts, phases, tasks, moduleFiles] = await Promise.all([
        ids.length ? pool.query("SELECT * FROM projects WHERE id IN (?) ORDER BY id DESC", [ids]) : [[], []],
        ids.length ? pool.query("SELECT * FROM modules WHERE project_id IN (?) ORDER BY id", [ids]) : [[], []],
        ids.length ? pool.query("SELECT * FROM milestones WHERE project_id IN (?) ORDER BY sort_order, id", [ids]) : [[], []],
        pool.query(
          `SELECT i.*, ru.display_name AS reporter_name, au.display_name AS assignee_name
           FROM issues i
           LEFT JOIN users ru ON i.reporter_id = ru.id
           LEFT JOIN users au ON i.assignee_id = au.id
           WHERE (i.project_id IN (?) OR i.assignee_id=? OR i.reporter_id=?)
           ORDER BY i.id DESC`,
          [ids.length ? ids : [-1], me.id, me.id]
        ),
        ids.length ? pool.query("SELECT * FROM module_updates WHERE project_id IN (?) ORDER BY update_date DESC, id DESC", [ids]) : [[], []],
        ids.length ? pool.query(
          `SELECT c.*, p.name AS project_name, u.display_name AS uploader_name FROM contracts c
           LEFT JOIN projects p ON c.project_id = p.id
           LEFT JOIN users u ON c.uploaded_by = u.id
           WHERE c.project_id IN (?) ORDER BY c.id DESC`, [ids]) : [[], []],
        ids.length ? pool.query("SELECT * FROM phases WHERE project_id IN (?) ORDER BY sort_order, id", [ids]) : [[], []],
        pool.query(
          `SELECT t.*, p.name AS project_name, m.name AS module_name,
                  u.display_name AS owner_name, pd.name AS predecessor_name, ph.name AS phase_name
           FROM tasks t
           LEFT JOIN projects p ON t.project_id = p.id
           LEFT JOIN modules m ON t.module_id = m.id
           LEFT JOIN users u ON t.owner_id = u.id
           LEFT JOIN tasks pd ON t.predecessor_id = pd.id
           LEFT JOIN phases ph ON t.phase_id = ph.id
           WHERE (t.project_id IN (?) OR t.owner_id=?)
           ORDER BY t.phase_id, t.sort_order, t.id`,
          [ids.length ? ids : [-1], me.id]
        ),
        ids.length ? pool.query(
          `SELECT f.*, m.name AS module_name, p.name AS project_name, u.display_name AS uploader_name
           FROM module_files f
           LEFT JOIN modules m ON f.module_id = m.id
           LEFT JOIN projects p ON f.project_id = p.id
           LEFT JOIN users u ON f.uploaded_by = u.id
           WHERE f.project_id IN (?) ORDER BY f.id DESC`, [ids]) : [[], []],
      ]);
      /* 指派给我/我提交的记录所属项目（可能不可见），补充名称供展示 */
      const issueRows = issues[0];
      const extraPids = [...new Set(issueRows.filter(x => !ids.includes(x.project_id)).map(x => x.project_id))];
      let issueProjects = [];
      if (extraPids.length) {
        [issueProjects] = await pool.query(
          "SELECT id, name, code, status FROM projects WHERE id IN (?)", [extraPids]
        );
      }
      /* 给每条记录附上项目名（可见项目 + 指派关联项目） */
      const nameMap = {};
      projects[0].forEach(x => { nameMap[x.id] = x.name; });
      issueProjects.forEach(x => { nameMap[x.id] = x.name; });
      issueRows.forEach(x => { x.project_name = nameMap[x.project_id] || null; });
      res.json({
        projects: projects[0], modules: modules[0],
        milestones: milestones[0], issues: issueRows, updates: updates[0],
        contracts: contracts[0], phases: phases[0], tasks: tasks[0],
        moduleFiles: moduleFiles[0],
        issueProjects,
      });
    } catch (e) { next(e); }
  });

  // ---- 静态页面 ----
  app.use(express.static(path.join(__dirname, "..", "public")));

  // ---- 统一错误处理 ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[api error]", err.message);
    res.status(500).json({ error: "服务器内部错误：" + err.message });
  });

  return app;
}

module.exports = { createApp };
