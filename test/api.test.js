/* 接口集成测试：需要本地 MySQL。
   若 .env 未配置或数据库连不上，则整体跳过（不算失败）。 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config();

/* 关键：测试使用独立库（<DB_NAME>_test），绝不污染生产数据 */
const TEST_DB = (process.env.DB_NAME || "pm_workbench") + "_test";

let pool, app, server, base;
let dbAvailable = false;

test.before(async () => {
  if (!process.env.DB_PASSWORD) return;
  try {
    const { initDb } = require("../server/db");
    pool = await initDb(Object.assign({}, process.env, { DB_NAME: TEST_DB }));
    dbAvailable = true;
    // 测试库首次运行：初始化测试管理员
    const { ensureAdmin } = require("../server/bootstrap");
    await ensureAdmin(pool, { AUTH_USERNAME: "tester", AUTH_PASSWORD: "test-pass-123" });
  } catch (e) {
    console.log("# (跳过集成测试：数据库不可用 -", e.code || e.message, ")");
    return;
  }
  // 确保 tester 管理员存在（登录改为查 users 表）
  const { hashPassword } = require("../server/auth");
  const [ex] = await pool.query("SELECT id FROM users WHERE username='tester'");
  if (!ex.length) {
    await pool.query("INSERT INTO users(username,password_hash,display_name,role) VALUES(?,?,?,?)",
      ["tester", hashPassword("test-pass-123"), "测试管理员", "admin"]);
  }
  const { createApp } = require("../server/app");
  // 合同上传使用临时目录，避免测试文件混入真实 uploads/
  const os = require("node:os");
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pmwb-uploads-"));
  app = createApp(pool, Object.assign({}, process.env, {
    AUTH_USERNAME: "tester", AUTH_PASSWORD: "test-pass-123", SESSION_SECRET: "test-secret",
    // 测试环境禁用真实大模型调用，固定走本地模板；主密钥固定，测试可重复
    LLM_API_KEY: "", OPENAI_API_KEY: "", LLM_BASE_URL: "",
    SETTINGS_SECRET: "test-settings-secret",
  }));
  await new Promise(r => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

async function req(method, path, body, cookie) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign(
      { "Content-Type": "application/json" },
      cookie ? { Cookie: cookie } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data, setCookie: r.headers.get("set-cookie") };
}

/* ---------- 认证 ---------- */
test("未登录访问业务接口返回 401", async () => {
  if (!dbAvailable) return;
  const r = await req("GET", "/api/projects");
  assert.equal(r.status, 401);
});
test("错误密码返回 401", async () => {
  if (!dbAvailable) return;
  const r = await req("POST", "/api/login", { username: "tester", password: "wrong" });
  assert.equal(r.status, 401);
});
test("正确账号密码登录成功", async () => {
  if (!dbAvailable) return;
  const r = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  assert.equal(r.status, 200);
});

/* ---------- 项目 + 里程碑 ---------- */
test("创建项目自动生成 5 个里程碑", async () => {
  if (!dbAvailable) return;
  const login = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = login.setCookie.split(";")[0];

  const created = await req("POST", "/api/projects", { name: "测试项目A" }, cookie);
  assert.equal(created.status, 201);
  const pid = created.data.id;

  const ms = await req("GET", "/api/milestones?project_id=" + pid, null, cookie);
  assert.equal(ms.data.length, 5);
  assert.deepEqual(ms.data.map(m => m.name), ["部署", "测试", "培训", "上线", "验收"]);

  // 编辑项目
  const upd = await req("PUT", "/api/projects/" + pid, { name: "测试项目A改", status: "进行中" }, cookie);
  assert.equal(upd.status, 200);

  // 清理
  const del = await req("DELETE", "/api/projects/" + pid, null, cookie);
  assert.equal(del.status, 200);
  const msAfter = await req("GET", "/api/milestones?project_id=" + pid, null, cookie);
  assert.equal(msAfter.data.length, 0); // 级联删除
});

/* ---------- 模块 ---------- */
test("模块校验：无法上线必须填原因", async () => {
  if (!dbAvailable) return;
  const login = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = login.setCookie.split(";")[0];
  const pid = (await req("POST", "/api/projects", { name: "测试项目B" }, cookie)).data.id;

  const bad = await req("POST", "/api/modules", { project_id: pid, name: "模块X", status: "无法上线", failReason: "" }, cookie);
  assert.equal(bad.status, 400);

  const good = await req("POST", "/api/modules", { project_id: pid, name: "模块X", status: "试运行", progress: "55" }, cookie);
  assert.equal(good.status, 201);

  const mods = await req("GET", "/api/modules?project_id=" + pid, null, cookie);
  assert.equal(mods.data[0].progress, 55);
  assert.equal(mods.data[0].status, "试运行");

  await req("DELETE", "/api/projects/" + pid, null, cookie);
});

/* ---------- 记录 ---------- */
test("记录：解决时间自动维护 + 条件筛选", async () => {
  if (!dbAvailable) return;
  const login = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = login.setCookie.split(";")[0];
  const pid = (await req("POST", "/api/projects", { name: "测试项目C" }, cookie)).data.id;

  const created = await req("POST", "/api/issues", { project_id: pid, title: "登录报错", type: "Bug", priority: "高" }, cookie);
  assert.equal(created.status, 201);
  const iid = created.data.id;

  // 处理中 → resolved_at 为空
  await req("PUT", "/api/issues/" + iid, { title: "登录报错", type: "Bug", priority: "高", status: "处理中" }, cookie);
  let one = (await req("GET", "/api/issues?project_id=" + pid, null, cookie)).data[0];
  assert.equal(one.resolved_at, null);

  // 标记解决 → resolved_at 写入；终态不允许退回处理中
  await req("PUT", "/api/issues/" + iid, { title: "登录报错", type: "Bug", priority: "高", status: "已解决" }, cookie);
  one = (await req("GET", "/api/issues?project_id=" + pid, null, cookie)).data[0];
  assert.ok(one.resolved_at, "resolved_at 应有值");
  assert.equal((await req("PUT", "/api/issues/" + iid,
    { title: "登录报错", type: "Bug", priority: "高", status: "处理中" }, cookie)).status, 400);

  // 筛选
  await req("POST", "/api/issues", { project_id: pid, title: "要个新报表", type: "需求" }, cookie);
  const bugs = await req("GET", "/api/issues?project_id=" + pid + "&type=Bug", null, cookie);
  assert.equal(bugs.data.length, 1);

  await req("DELETE", "/api/projects/" + pid, null, cookie);
});

/* ---------- 多用户与可见性 ---------- */
const PW1 = "pass" + "1234", PW2 = "new" + "pass9";
test("多用户：普通用户只能看到自己登记/负责的项目，管理员看全部", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];

  // 管理员创建两个普通用户
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1000);
  const u1n = "u1_" + suffix, u2n = "u2_" + suffix;
  const cu1 = await req("POST", "/api/users", { username: u1n, password: PW1, display_name: "张三", role: "user" }, aCookie);
  assert.equal(cu1.status, 201);
  const cu2 = await req("POST", "/api/users", { username: u2n, password: PW1, display_name: "李四", role: "user" }, aCookie);
  assert.equal(cu2.status, 201);

  // 普通用户访问用户管理 → 403
  const u1Login = await req("POST", "/api/login", { username: u1n, password: PW1 });
  const u1Cookie = u1Login.setCookie.split(";")[0];
  assert.equal((await req("GET", "/api/users", null, u1Cookie)).status, 403);

  // u1 建项目 → u2 看不到，u1 和管理员看得到
  const p1 = await req("POST", "/api/projects", { name: "多用户可见性测试" }, u1Cookie);
  const pid = p1.data.id;
  const u2Login = await req("POST", "/api/login", { username: u2n, password: PW1 });
  const u2Cookie = u2Login.setCookie.split(";")[0];
  assert.equal((await req("GET", "/api/projects", null, u2Cookie)).data.some(p => p.id === pid), false);
  assert.equal((await req("GET", "/api/projects", null, u1Cookie)).data.some(p => p.id === pid), true);
  assert.equal((await req("GET", "/api/projects", null, aCookie)).data.some(p => p.id === pid), true);

  // u2 不能往 u1 的项目里加模块、不能删该项目
  assert.equal((await req("POST", "/api/modules", { project_id: pid, name: "x" }, u2Cookie)).status, 403);
  assert.equal((await req("DELETE", "/api/projects/" + pid, null, u2Cookie)).status, 403);

  // u1 把负责人改成 u2 → u2 可见（负责的项目）
  await req("PUT", "/api/projects/" + pid, { name: "多用户可见性测试", owner: u2n }, u1Cookie);
  assert.equal((await req("GET", "/api/projects", null, u2Cookie)).data.some(p => p.id === pid), true);

  // 清理
  await req("DELETE", "/api/projects/" + pid, null, aCookie);
  await req("DELETE", "/api/users/" + cu1.data.id, null, aCookie);
  await req("DELETE", "/api/users/" + cu2.data.id, null, aCookie);
});

test("用户管理：不能删除自己、不能降级最后一个管理员", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  const me = (await req("GET", "/api/me", null, aCookie)).data.user;
  assert.equal((await req("DELETE", "/api/users/" + me.id, null, aCookie)).status, 400);
  assert.equal((await req("PUT", "/api/users/" + me.id, { role: "user" }, aCookie)).status, 400);
});

test("用户管理：重置密码生效", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  const suffix = Date.now().toString(36);
  const un = "rp_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "old" + "pass1", role: "user" }, aCookie);
  await req("PUT", "/api/users/" + cu.data.id, { password: PW2 }, aCookie);
  assert.equal((await req("POST", "/api/login", { username: un, password: "old" + "pass1" })).status, 401);
  assert.equal((await req("POST", "/api/login", { username: un, password: PW2 })).status, 200);
  await req("DELETE", "/api/users/" + cu.data.id, null, aCookie);
});

/* ---------- 多用户与可见性 ---------- */
test("多用户：普通用户只能看到自己登记/负责的项目，管理员看全部", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];

  // 管理员创建两个普通用户
  const suffix = Date.now().toString(36) + Math.floor(Math.random()*1000);
  const u1n = "u1_" + suffix, u2n = "u2_" + suffix;
  const cu1 = await req("POST", "/api/users", { username: u1n, password: "pass1234", display_name: "张三", role: "user" }, aCookie);
  assert.equal(cu1.status, 201);
  const cu2 = await req("POST", "/api/users", { username: u2n, password: "pass1234", display_name: "李四", role: "user" }, aCookie);
  assert.equal(cu2.status, 201);

  // 普通用户访问用户管理 → 403
  const u1Login = await req("POST", "/api/login", { username: u1n, password: "pass1234" });
  const u1Cookie = u1Login.setCookie.split(";")[0];
  assert.equal((await req("GET", "/api/users", null, u1Cookie)).status, 403);

  // u1 建项目 → u2 看不到，u1 和管理员看得到
  const p1 = await req("POST", "/api/projects", { name: "多用户可见性测试" }, u1Cookie);
  const pid = p1.data.id;
  const u2Login = await req("POST", "/api/login", { username: u2n, password: "pass1234" });
  const u2Cookie = u2Login.setCookie.split(";")[0];
  assert.equal((await req("GET", "/api/projects", null, u2Cookie)).data.some(p => p.id === pid), false);
  assert.equal((await req("GET", "/api/projects", null, u1Cookie)).data.some(p => p.id === pid), true);
  assert.equal((await req("GET", "/api/projects", null, aCookie)).data.some(p => p.id === pid), true);

  // u2 不能往 u1 的项目里加模块、不能删该项目
  assert.equal((await req("POST", "/api/modules", { project_id: pid, name: "x" }, u2Cookie)).status, 403);
  assert.equal((await req("DELETE", "/api/projects/" + pid, null, u2Cookie)).status, 403);

  // u1 把负责人改成 u2 → u2 可见（负责的项目）
  await req("PUT", "/api/projects/" + pid, { name: "多用户可见性测试", owner: u2n }, u1Cookie);
  assert.equal((await req("GET", "/api/projects", null, u2Cookie)).data.some(p => p.id === pid), true);

  // 清理
  await req("DELETE", "/api/projects/" + pid, null, aCookie);
  await req("DELETE", "/api/users/" + cu1.data.id, null, aCookie);
  await req("DELETE", "/api/users/" + cu2.data.id, null, aCookie);
});

test("用户管理：不能删除自己、不能删除最后一个管理员", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  const me = (await req("GET", "/api/me", null, aCookie)).data.user;
  assert.equal((await req("DELETE", "/api/users/" + me.id, null, aCookie)).status, 400);
  // 降级自己（唯一管理员）→ 400
  assert.equal((await req("PUT", "/api/users/" + me.id, { role: "user" }, aCookie)).status, 400);
});

test("用户管理：重置密码生效", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  const suffix = Date.now().toString(36);
  const un = "rp_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "oldpass1", role: "user" }, aCookie);
  assert.equal(cu.status, 201);
  await req("PUT", "/api/users/" + cu.data.id, { password: "newpass9" }, aCookie);
  assert.equal((await req("POST", "/api/login", { username: un, password: "oldpass1" })).status, 401);
  assert.equal((await req("POST", "/api/login", { username: un, password: "newpass9" })).status, 200);
  await req("DELETE", "/api/users/" + cu.data.id, null, aCookie);
});

/* ---------- 进度记录与自动汇总 ---------- */
test("进度记录：写入同步模块进度、取最新一条、删除后回退", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = aLogin.setCookie.split(";")[0];
  const p = await req("POST", "/api/projects", { name: "进度记录测试" }, cookie);
  const pid = p.data.id;
  const m = await req("POST", "/api/modules", { project_id: pid, name: "模块A", progress: 0 }, cookie);
  const mid = m.data.id;

  await req("POST", "/api/updates", { module_id: mid, update_date: "2026-10-26", progress: 40, note: "上周" }, cookie);
  let mods = (await req("GET", "/api/modules?project_id=" + pid, null, cookie)).data;
  assert.equal(mods.find(x => x.id === mid).progress, 40);

  await req("POST", "/api/updates", { module_id: mid, update_date: "2026-11-02", progress: 70, note: "本周" }, cookie);
  mods = (await req("GET", "/api/modules?project_id=" + pid, null, cookie)).data;
  assert.equal(mods.find(x => x.id === mid).progress, 70); // 取最新日期

  // 乱序补录更早日期的记录，不应覆盖最新进度
  await req("POST", "/api/updates", { module_id: mid, update_date: "2026-10-20", progress: 10 }, cookie);
  mods = (await req("GET", "/api/modules?project_id=" + pid, null, cookie)).data;
  assert.equal(mods.find(x => x.id === mid).progress, 70);

  const ups = (await req("GET", "/api/updates?module_id=" + mid, null, cookie)).data;
  assert.equal(ups.length, 3);
  assert.equal(ups[0].progress, 70); // 排序：最新在前

  // 删除最新记录 → 模块进度回退到次新
  const latest = ups.find(u => u.progress === 70);
  await req("DELETE", "/api/updates/" + latest.id, null, cookie);
  mods = (await req("GET", "/api/modules?project_id=" + pid, null, cookie)).data;
  assert.equal(mods.find(x => x.id === mid).progress, 40);

  // 缺日期被拒
  assert.equal((await req("POST", "/api/updates", { module_id: mid, progress: 99 }, cookie)).status, 400);

  await req("DELETE", "/api/projects/" + pid, null, cookie);
});

test("进度记录：bootstrap 含 updates、不可见项目被过滤", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = aLogin.setCookie.split(";")[0];
  const p = await req("POST", "/api/projects", { name: "进度可见性测试" }, cookie);
  const pid = p.data.id;
  const m = await req("POST", "/api/modules", { project_id: pid, name: "模块B" }, cookie);
  await req("POST", "/api/updates", { module_id: m.data.id, update_date: "2026-11-01", progress: 30 }, cookie);

  const boot = (await req("GET", "/api/bootstrap", null, cookie)).data;
  assert.ok(Array.isArray(boot.updates));
  assert.ok(boot.updates.some(u => u.module_id === m.data.id));

  const suffix = Date.now().toString(36);
  const cu = await req("POST", "/api/users", { username: "up_" + suffix, password: "pass1234", role: "user" }, cookie);
  const uLogin = await req("POST", "/api/login", { username: "up_" + suffix, password: "pass1234" });
  const uCookie = uLogin.setCookie.split(";")[0];
  assert.equal((await req("GET", "/api/updates?project_id=" + pid, null, uCookie)).data.length, 0);
  assert.equal((await req("POST", "/api/updates", { module_id: m.data.id, update_date: "2026-11-01", progress: 50 }, uCookie)).status, 403);

  await req("DELETE", "/api/projects/" + pid, null, cookie);
  await req("DELETE", "/api/users/" + cu.data.id, null, cookie);
});

/* ---------- 问题指派与流转 ---------- */
test("问题流转：指派→已完成（必填完成状况）→已解决；非法流转被拒", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = aLogin.setCookie.split(";")[0];

  // 建普通用户作为处理人
  const suffix = Date.now().toString(36);
  const un = "asg_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", display_name: "处理人甲", role: "user" }, cookie);
  assert.equal(cu.status, 201);

  // 可指派用户列表：普通用户也能访问
  const uLogin = await req("POST", "/api/login", { username: un, password: "pass1234" });
  const uCookie = uLogin.setCookie.split(";")[0];
  const asg = await req("GET", "/api/assignees", null, uCookie);
  assert.equal(asg.status, 200);
  const target = asg.data.find(x => x.id === cu.data.id);
  assert.ok(target, "指派列表包含新用户");

  // 提交问题并指派
  const p = await req("POST", "/api/projects", { name: "问题流转测试" }, cookie);
  const pid = p.data.id;
  const iss = await req("POST", "/api/issues",
    { project_id: pid, type: "Bug", title: "导出报表报错", assignee_id: cu.data.id, plan_date: "2026-11-10" }, cookie);
  assert.equal(iss.status, 201);
  let row = (await req("GET", "/api/issues?project_id=" + pid, null, cookie)).data[0];
  assert.equal(row.assignee_id, cu.data.id);
  assert.equal(row.reporter_id, 1);
  assert.equal(row.owner, "处理人甲", "指派后自动填展示名");
  assert.equal(row.plan_date, "2026-11-10");

  // 未填完成状况直接提交已完成 → 400
  assert.equal((await req("PUT", "/api/issues/" + row.id,
    { type: "Bug", title: "导出报表报错", status: "已完成", assignee_id: cu.data.id, priority: "中" }, cookie)).status, 400);

  // 处理人提交已完成（填完成状况/实际时间/工时）
  const fin = await req("PUT", "/api/issues/" + row.id,
    { type: "Bug", title: "导出报表报错", status: "已完成", assignee_id: cu.data.id, priority: "中",
      actual_date: "2026-11-09", actual_hours: 4.5, finish_note: "修复了导出空指针" }, cookie);
  assert.equal(fin.status, 200);
  row = (await req("GET", "/api/issues?project_id=" + pid, null, cookie)).data[0];
  assert.equal(row.status, "已完成");
  assert.equal(row.actual_hours, 4.5);
  assert.equal(row.finish_note, "修复了导出空指针");

  // 已完成 → 已解决（提交人测试通过）
  assert.equal((await req("PUT", "/api/issues/" + row.id,
    { type: "Bug", title: "导出报表报错", status: "已解决", assignee_id: cu.data.id, priority: "中" }, cookie)).status, 200);
  row = (await req("GET", "/api/issues?project_id=" + pid, null, cookie)).data[0];
  assert.equal(row.status, "已解决");
  assert.ok(row.resolved_at, "已解决时间已写入");

  // 终态不允许退回处理中
  assert.equal((await req("PUT", "/api/issues/" + row.id,
    { type: "Bug", title: "导出报表报错", status: "处理中", assignee_id: cu.data.id, priority: "中" }, cookie)).status, 400);

  // 指派不存在的用户 → 400
  assert.equal((await req("PUT", "/api/issues/" + row.id,
    { type: "Bug", title: "x", status: "已解决", assignee_id: 999999, priority: "中" }, cookie)).status, 400);

  await req("DELETE", "/api/projects/" + pid, null, cookie);
  await req("DELETE", "/api/users/" + cu.data.id, null, cookie);
});

test("问题部分提交：未提供的字段保持原值（不清空指派/日期/工时）", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = aLogin.setCookie.split(";")[0];
  const suffix = Date.now().toString(36);
  const un = "pp_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", display_name: "部分提交甲", role: "user" }, cookie);
  const p = await req("POST", "/api/projects", { name: "部分提交测试" }, cookie);
  const pid = p.data.id;
  const iss = await req("POST", "/api/issues",
    { project_id: pid, type: "Bug", title: "部分提交问题", assignee_id: cu.data.id, plan_date: "2026-11-20", priority: "高" }, cookie);
  const iid = iss.data.id;

  // 只传 status+finish_note（模拟处理人提交完成）
  await req("PUT", "/api/issues/" + iid, { status: "已完成", finish_note: "完成了" }, cookie);
  const row = (await req("GET", "/api/issues?project_id=" + pid, null, cookie)).data[0];
  assert.equal(row.assignee_id, cu.data.id, "指派未丢");
  assert.equal(row.plan_date, "2026-11-20", "计划完成未丢");
  assert.equal(row.priority, "高", "优先级未丢");
  assert.ok(row.actual_date, "实际完成自动补今天");

  await req("DELETE", "/api/projects/" + pid, null, cookie);
  await req("DELETE", "/api/users/" + cu.data.id, null, cookie);
});

test("问题指派可见性：普通用户能看到/处理指派给自己的记录（即使项目不可见）", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = aLogin.setCookie.split(";")[0];
  const suffix = Date.now().toString(36);
  const un = "vis_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", display_name: "可见性甲", role: "user" }, cookie);
  const uLogin = await req("POST", "/api/login", { username: un, password: "pass1234" });
  const uCookie = uLogin.setCookie.split(";")[0];

  // 管理员建项目（owner 留空 → 普通用户不可见），再指派问题给该用户
  const p = await req("POST", "/api/projects", { name: "指派可见性测试" }, cookie);
  const pid = p.data.id;
  const pre = (await req("GET", "/api/projects", null, uCookie)).data;
  assert.equal(pre.some(x => x.id === pid), false, "项目本身不可见");

  const iss = await req("POST", "/api/issues",
    { project_id: pid, type: "需求", title: "加个导出按钮", assignee_id: cu.data.id, plan_date: "2026-11-20" }, cookie);
  const iid = iss.data.id;

  // bootstrap 包含该记录与项目名称
  const boot = (await req("GET", "/api/bootstrap", null, uCookie)).data;
  const mine = boot.issues.find(x => x.id === iid);
  assert.ok(mine, "指派的记录对我可见");
  assert.equal(mine.project_name, "指派可见性测试");

  // GET /api/issues 也包含
  assert.ok((await req("GET", "/api/issues", null, uCookie)).data.some(x => x.id === iid));

  // 指派给我的记录可以流转
  assert.equal((await req("PUT", "/api/issues/" + iid,
    { type: "需求", title: "加个导出按钮", status: "处理中", assignee_id: cu.data.id, priority: "中" }, uCookie)).status, 200);

  // 与我无关的记录不可见、不可改
  const other = await req("POST", "/api/issues", { project_id: pid, type: "问题", title: "别人的记录" }, cookie);
  assert.equal((await req("GET", "/api/issues", null, uCookie)).data.some(x => x.id === other.data.id), false);
  assert.equal((await req("PUT", "/api/issues/" + other.data.id,
    { type: "问题", title: "偷改", status: "已解决", priority: "中" }, uCookie)).status, 403);

  await req("DELETE", "/api/projects/" + pid, null, cookie);
  await req("DELETE", "/api/users/" + cu.data.id, null, cookie);
});

/* ---------- 合同管理（上传/下载/删除） ---------- */
test("合同：上传→列表→下载内容一致→改元数据→删除", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = aLogin.setCookie.split(";")[0];
  const p = await req("POST", "/api/projects", { name: "合同管理测试" }, cookie);
  const pid = p.data.id;

  const fd = new FormData();
  fd.append("project_id", String(pid));
  fd.append("name", "软件采购合同");
  fd.append("code", "HT-2026-001");
  fd.append("amount", "128000.5");
  fd.append("signDate", "2026-11-01");
  fd.append("note", "含一年维保");
  fd.append("file", new Blob(["contract-content-123"], { type: "application/pdf" }), "采购合同.pdf");

  const up = await fetch(base + "/api/contracts", { method: "POST", headers: { Cookie: cookie }, body: fd });
  assert.equal(up.status, 201);
  const cid = (await up.json()).id;

  // 列表：bootstrap 与 GET /api/contracts 均可见，含项目名与上传人
  const list = (await req("GET", "/api/contracts", null, cookie)).data;
  const row = list.find(x => x.id === cid);
  assert.ok(row, "合同在列表中");
  assert.equal(row.project_name, "合同管理测试");
  assert.equal(row.file_name, "采购合同.pdf");
  assert.equal(row.amount, 128000.5);
  const boot = (await req("GET", "/api/bootstrap", null, cookie)).data;
  assert.ok(boot.contracts.some(x => x.id === cid));

  // 下载：内容一致、文件名带中文
  const dl = await fetch(base + "/api/contracts/" + cid + "/file", { headers: { Cookie: cookie } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), "contract-content-123");
  assert.ok(dl.headers.get("content-disposition").includes("UTF-8''"), "中文文件名 RFC5987 编码");

  // 编辑元数据（不换文件）
  const upd = await fetch(base + "/api/contracts/" + cid, {
    method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "软件采购合同V2", amount: "130000" }),
  });
  assert.equal(upd.status, 200);
  const row2 = (await req("GET", "/api/contracts", null, cookie)).data.find(x => x.id === cid);
  assert.equal(row2.name, "软件采购合同V2");
  assert.equal(row2.amount, 130000);
  assert.equal(row2.file_name, "采购合同.pdf", "文件未被替换");

  // 缺名称 / 缺文件 被拒
  const noName = new FormData();
  noName.append("project_id", String(pid));
  noName.append("file", new Blob(["x"]), "a.pdf");
  assert.equal((await fetch(base + "/api/contracts", { method: "POST", headers: { Cookie: cookie }, body: noName })).status, 400);
  const noFile = new FormData();
  noFile.append("project_id", String(pid));
  noFile.append("name", "测试合同");
  assert.equal((await fetch(base + "/api/contracts", { method: "POST", headers: { Cookie: cookie }, body: noFile })).status, 400);

  // 删除合同
  const del = await req("DELETE", "/api/contracts/" + cid, null, cookie);
  assert.equal(del.status, 200);
  assert.equal((await req("GET", "/api/contracts", null, cookie)).data.some(x => x.id === cid), false);
  assert.equal((await fetch(base + "/api/contracts/" + cid + "/file", { headers: { Cookie: cookie } })).status, 404);

  await req("DELETE", "/api/projects/" + pid, null, cookie);
});

test("合同可见性与权限：普通用户看不到别人项目的合同，也不能下载", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  const suffix = Date.now().toString(36);
  const un = "ct_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", role: "user" }, aCookie);
  const uLogin = await req("POST", "/api/login", { username: un, password: "pass1234" });
  const uCookie = uLogin.setCookie.split(";")[0];

  // 管理员建项目（无 owner → 普通用户不可见）并上传合同
  const p = await req("POST", "/api/projects", { name: "合同可见性测试" }, aCookie);
  const pid = p.data.id;
  const fd = new FormData();
  fd.append("project_id", String(pid));
  fd.append("name", "秘密合同");
  fd.append("file", new Blob(["secret"], { type: "text/plain" }), "secret.txt");
  const up = await fetch(base + "/api/contracts", { method: "POST", headers: { Cookie: aCookie }, body: fd });
  const cid = (await up.json()).id;

  const list = (await req("GET", "/api/contracts", null, uCookie)).data;
  assert.equal(list.some(x => x.id === cid), false, "不可见项目合同不在列表");
  assert.equal((await fetch(base + "/api/contracts/" + cid + "/file", { headers: { Cookie: uCookie } })).status, 403);
  assert.equal((await fetch(base + "/api/contracts/" + cid, { method: "DELETE", headers: { Cookie: uCookie } })).status, 403);

  // 项目给 owner 后可见
  await req("PUT", "/api/projects/" + pid, { name: "合同可见性测试", owner: un }, aCookie);
  assert.ok((await req("GET", "/api/contracts", null, uCookie)).data.some(x => x.id === cid));
  assert.equal((await fetch(base + "/api/contracts/" + cid + "/file", { headers: { Cookie: uCookie } })).status, 200);

  // 项目删除 → 合同级联删除
  await req("DELETE", "/api/projects/" + pid, null, aCookie);
  assert.equal((await req("GET", "/api/contracts", null, aCookie)).data.some(x => x.id === cid), false);
  await req("DELETE", "/api/users/" + cu.data.id, null, aCookie);
});

/* ---------- 模块附件（培训签到单 / 上线确认单 / 验收报告等） ---------- */
test("模块附件：多文件上传、分类、下载、改类、删除与级联清理", async () => {
  if (!dbAvailable) return;
  const login = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = login.setCookie.split(";")[0];
  const pid = (await req("POST", "/api/projects", { name: "附件测试项目" }, cookie)).data.id;
  const mid = (await req("POST", "/api/modules", { project_id: pid, name: "附件模块" }, cookie)).data.id;

  // 一次上传两个文件（同一类型）
  const fd = new FormData();
  fd.append("module_id", String(mid));
  fd.append("category", "培训签到单");
  fd.append("note", "培训 18 人签到");
  fd.append("files", new Blob(["sign-1"], { type: "application/pdf" }), "培训签到单.pdf");
  fd.append("files", new Blob(["sign-2"], { type: "image/png" }), "现场照片.png");
  const up = await fetch(base + "/api/module-files", { method: "POST", headers: { Cookie: cookie }, body: fd });
  assert.equal(up.status, 201);
  const upJson = await up.json();
  assert.equal(upJson.count, 2);
  assert.equal(upJson.ids.length, 2);

  // 列表：中文文件名不乱码，带模块名/上传人/说明
  const list = (await req("GET", "/api/module-files?module_id=" + mid, null, cookie)).data;
  assert.equal(list.length, 2);
  const first = list.find(x => x.file_name === "培训签到单.pdf");
  assert.ok(first, "中文文件名原样保存");
  assert.equal(first.category, "培训签到单");
  assert.equal(first.module_name, "附件模块");
  assert.equal(first.note, "培训 18 人签到");
  assert.ok(first.uploader_name);
  const boot = (await req("GET", "/api/bootstrap", null, cookie)).data;
  assert.equal(boot.moduleFiles.filter(x => x.module_id === mid).length, 2, "bootstrap 携带附件");

  // 下载
  const dl = await fetch(base + "/api/module-files/" + first.id + "/file", { headers: { Cookie: cookie } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), "sign-1");
  assert.ok(dl.headers.get("content-disposition").includes("UTF-8''"), "中文文件名 RFC5987 编码");

  // 改类型/说明（不换文件）
  const put = await fetch(base + "/api/module-files/" + first.id, {
    method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ category: "模块验收报告", note: "验收通过" }),
  });
  assert.equal(put.status, 200);
  const row = (await req("GET", "/api/module-files?module_id=" + mid, null, cookie)).data.find(x => x.id === first.id);
  assert.equal(row.category, "模块验收报告");
  assert.equal(row.note, "验收通过");

  // 非法类型被拒，且已落盘文件被清理
  const before = fs.readdirSync(process.env.UPLOAD_DIR).length;
  const badFd = new FormData();
  badFd.append("module_id", String(mid));
  badFd.append("category", "随便什么");
  badFd.append("files", new Blob(["x"]), "a.pdf");
  const bad = await fetch(base + "/api/module-files", { method: "POST", headers: { Cookie: cookie }, body: badFd });
  assert.equal(bad.status, 400);
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, before, "校验失败不残留磁盘文件");

  // 缺模块 / 模块不存在
  const noMod = new FormData();
  noMod.append("category", "其他");
  noMod.append("files", new Blob(["x"]), "a.pdf");
  assert.equal((await fetch(base + "/api/module-files", { method: "POST", headers: { Cookie: cookie }, body: noMod })).status, 400);
  const ghost = new FormData();
  ghost.append("module_id", "99999999");
  ghost.append("category", "其他");
  ghost.append("files", new Blob(["x"]), "a.pdf");
  assert.equal((await fetch(base + "/api/module-files", { method: "POST", headers: { Cookie: cookie }, body: ghost })).status, 404);

  // 删除单个附件 → 数据库与磁盘同步清理
  const stored = first.stored_name;
  assert.equal((await req("DELETE", "/api/module-files/" + first.id, null, cookie)).status, 200);
  assert.equal((await fetch(base + "/api/module-files/" + first.id + "/file", { headers: { Cookie: cookie } })).status, 404);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, stored)), false, "磁盘文件已删除");

  // 删除模块 → 剩余附件级联删除，磁盘同步
  const left = (await req("GET", "/api/module-files?module_id=" + mid, null, cookie)).data;
  assert.equal(left.length, 1);
  assert.equal((await req("DELETE", "/api/modules/" + mid, null, cookie)).status, 200);
  assert.equal((await req("GET", "/api/module-files?module_id=" + mid, null, cookie)).data.length, 0);
  left.forEach(x => assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, x.stored_name)), false));

  await req("DELETE", "/api/projects/" + pid, null, cookie);
});

test("模块附件权限：不可见项目的附件不能列表/下载/删除/上传", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  const suffix = Date.now().toString(36);
  const un = "mf_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", role: "user" }, aCookie);
  const uLogin = await req("POST", "/api/login", { username: un, password: "pass1234" });
  const uCookie = uLogin.setCookie.split(";")[0];

  const pid = (await req("POST", "/api/projects", { name: "附件权限测试" }, aCookie)).data.id;
  const mid = (await req("POST", "/api/modules", { project_id: pid, name: "验收模块" }, aCookie)).data.id;
  const fd = new FormData();
  fd.append("module_id", String(mid));
  fd.append("category", "上线确认单");
  fd.append("files", new Blob(["confirm"]), "上线确认单.pdf");
  const up = await fetch(base + "/api/module-files", { method: "POST", headers: { Cookie: aCookie }, body: fd });
  assert.equal(up.status, 201);
  const fid = (await up.json()).ids[0];

  // 普通用户看不到该项目
  assert.equal((await req("GET", "/api/module-files", null, uCookie)).data.some(x => x.id === fid), false);
  assert.equal((await fetch(base + "/api/module-files/" + fid + "/file", { headers: { Cookie: uCookie } })).status, 403);
  assert.equal((await fetch(base + "/api/module-files/" + fid, { method: "DELETE", headers: { Cookie: uCookie } })).status, 403);
  const upFd = new FormData();
  upFd.append("module_id", String(mid));
  upFd.append("category", "其他");
  upFd.append("files", new Blob(["x"]), "x.pdf");
  assert.equal((await fetch(base + "/api/module-files", { method: "POST", headers: { Cookie: uCookie }, body: upFd })).status, 403);

  // 项目负责人设为该用户后可见、可下载
  await req("PUT", "/api/projects/" + pid, { name: "附件权限测试", owner: un }, aCookie);
  assert.ok((await req("GET", "/api/module-files", null, uCookie)).data.some(x => x.id === fid));
  assert.equal((await fetch(base + "/api/module-files/" + fid + "/file", { headers: { Cookie: uCookie } })).status, 200);

  // 项目删除 → 附件级联删除
  await req("DELETE", "/api/projects/" + pid, null, aCookie);
  assert.equal((await req("GET", "/api/module-files", null, aCookie)).data.some(x => x.id === fid), false);
  await req("DELETE", "/api/users/" + cu.data.id, null, aCookie);
});

/* ---------- 周报（大模型未配置时走本地模板） ---------- */
test("周报：按周聚合进度生成、同周覆盖、历史可查", async () => {
  if (!dbAvailable) return;
  const login = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const cookie = login.setCookie.split(";")[0];
  const p = await req("POST", "/api/projects", { name: "周报生成测试" }, cookie);
  const pid = p.data.id;
  const m = await req("POST", "/api/modules", { project_id: pid, name: "周报模块A", progress: 0 }, cookie);
  const mid = m.data.id;

  // 上周一条 + 本周一条，验证周报只取本周并对上周进度做基线
  await req("POST", "/api/updates", { module_id: mid, update_date: "2026-10-21", progress: 20, note: "上周工作" }, cookie);
  await req("POST", "/api/updates", { module_id: mid, update_date: "2026-10-28", progress: 45, note: "完成登录模块联调" }, cookie);
  await req("POST", "/api/issues", { project_id: pid, title: "导出报错", type: "Bug", priority: "高" }, cookie);

  const cfg = await req("GET", "/api/reports/config", null, cookie);
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.llm, false);

  const g = await req("POST", "/api/reports/generate", { project_id: pid, week_start: "2026-10-28" }, cookie);
  assert.equal(g.status, 200);
  assert.equal(g.data.week_start, "2026-10-26", "日期吸附到周一");
  assert.equal(g.data.week_end, "2026-11-01");
  assert.equal(g.data.source, "template");
  assert.ok(g.data.warning.includes("大模型"), "提示未配置模型");
  const md = g.data.content;
  assert.ok(md.includes("周报生成测试"), "含项目名");
  assert.ok(md.includes("2026-10-26 至 2026-11-01"), "含周期");
  assert.ok(md.includes("周报模块A"), "含模块名");
  assert.ok(md.includes("20%") && md.includes("45%"), "含上周/本周进度");
  assert.ok(md.includes("+25%"), "含进度变化");
  assert.ok(md.includes("完成登录模块联调"), "含本周说明");
  assert.ok(md.includes("导出报错"), "含本周新增问题");

  // 同周重新生成 → 覆盖同一行，不重复插入
  const g2 = await req("POST", "/api/reports/generate", { project_id: pid, week_start: "2026-10-26" }, cookie);
  assert.equal(g2.data.id, g.data.id);
  const list = (await req("GET", "/api/reports?project_id=" + pid, null, cookie)).data;
  assert.equal(list.length, 1);

  // 全文接口
  const one = await req("GET", "/api/reports/" + g.data.id, null, cookie);
  assert.equal(one.status, 200);
  assert.ok(one.data.content.includes("下周计划"));

  // 下载 Word：真正的 .docx（zip 包），文件名带项目名
  const dl = await fetch(base + "/api/reports/" + g.data.id + "/docx", { headers: { Cookie: cookie } });
  assert.equal(dl.status, 200);
  assert.ok((dl.headers.get("content-type") || "").includes("wordprocessingml"), "Content-Type 为 docx");
  const cd = dl.headers.get("content-disposition") || "";
  assert.ok(cd.includes("attachment"), "作为附件下载");
  assert.ok(cd.includes("filename*=UTF-8''"), "中文文件名用 RFC5987 编码");
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString("latin1"), "PK", "docx 是 zip 容器");
  assert.ok(buf.length > 3000, "包体大小合理：" + buf.length);
  assert.ok(buf.includes("word/document.xml"), "包含正文 XML");

  // 参数校验
  assert.equal((await req("POST", "/api/reports/generate", { week_start: "2026-10-26" }, cookie)).status, 400);
  assert.equal((await req("POST", "/api/reports/generate", { project_id: pid, week_start: "2026-13-01" }, cookie)).status, 400);

  await req("DELETE", "/api/projects/" + pid, null, cookie);
});

test("周报权限：普通用户不能生成/查看不可见项目的周报", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  const suffix = Date.now().toString(36);
  const un = "rp2_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", role: "user" }, aCookie);
  const uLogin = await req("POST", "/api/login", { username: un, password: "pass1234" });
  const uCookie = uLogin.setCookie.split(";")[0];

  const p = await req("POST", "/api/projects", { name: "周报权限测试" }, aCookie);
  const pid = p.data.id;
  const g = await req("POST", "/api/reports/generate", { project_id: pid, week_start: "2026-10-26" }, aCookie);
  assert.equal(g.status, 200);

  assert.equal((await req("POST", "/api/reports/generate", { project_id: pid, week_start: "2026-10-26" }, uCookie)).status, 403);
  assert.equal((await req("GET", "/api/reports/" + g.data.id, null, uCookie)).status, 403);
  assert.equal((await req("GET", "/api/reports?project_id=" + pid, null, uCookie)).data.length, 0);
  assert.equal((await req("DELETE", "/api/reports/" + g.data.id, null, uCookie)).status, 403);
  assert.equal((await fetch(base + "/api/reports/" + g.data.id + "/docx", { headers: { Cookie: uCookie } })).status, 403,
    "无权用户不能下载 Word");

  await req("DELETE", "/api/projects/" + pid, null, aCookie);
  await req("DELETE", "/api/users/" + cu.data.id, null, aCookie);
});

/* ---------- 大模型密钥：加密存储，接口不回传密钥任何片段 ---------- */
const FAKE_KEY = "sk-test-1234567890abcd";
test("设置：密钥加密入库、接口只回模型名、普通用户无权访问", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  await pool.query("DELETE FROM app_settings");

  const empty = await req("GET", "/api/settings/llm", null, aCookie);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.configured, false);
  assert.equal(empty.data.masked, undefined, "不再回传密钥掩码");

  // 保存（接口地址指向本地不可达端口，避免测试发外网请求）
  const saved = await req("PUT", "/api/settings/llm", {
    api_key: FAKE_KEY, base_url: "http://127.0.0.1:9/v1", model: "deepseek-chat",
  }, aCookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.configured, true);
  assert.equal(saved.data.masked, undefined, "不再回传密钥掩码");
  assert.equal(saved.data.model, "deepseek-chat", "只回模型名");
  assert.ok(!JSON.stringify(saved.data).includes(FAKE_KEY), "响应体不得含明文密钥");
  assert.ok(!JSON.stringify(saved.data).includes("abcd"), "响应体不得含密钥片段");

  const got = await req("GET", "/api/settings/llm", null, aCookie);
  assert.ok(!JSON.stringify(got.data).includes(FAKE_KEY), "查询接口不得含明文密钥");
  assert.equal(got.data.masked, undefined, "查询接口不回传掩码");
  assert.equal(got.data.model, "deepseek-chat");

  // 库里存的是密文
  const [[row]] = await pool.query("SELECT v FROM app_settings WHERE k='llm_api_key'");
  assert.ok(row.v.startsWith("v1:"), "密文带版本前缀");
  assert.ok(!row.v.includes(FAKE_KEY), "数据库中不得出现明文密钥");
  const { decryptSecret } = require("../server/crypto");
  assert.equal(decryptSecret(row.v, { SETTINGS_SECRET: "test-settings-secret" }), FAKE_KEY, "服务端可解密使用");

  // 周报配置接口：只有模型名，没有任何密钥痕迹
  const cfg = await req("GET", "/api/reports/config", null, aCookie);
  assert.equal(cfg.data.llm, true);
  assert.equal(cfg.data.masked, undefined);
  assert.equal(cfg.data.model, "deepseek-chat");
  assert.ok(!JSON.stringify(cfg.data).includes(FAKE_KEY));

  // 留空 api_key 表示不修改，仍保持已配置
  const keep = await req("PUT", "/api/settings/llm", { api_key: "", base_url: "http://127.0.0.1:9/v1" }, aCookie);
  assert.equal(keep.data.configured, true);
  assert.equal(keep.data.model, "deepseek-chat");

  // 普通用户无权访问设置
  const suffix = Date.now().toString(36);
  const un = "st_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", role: "user" }, aCookie);
  const uCookie = (await req("POST", "/api/login", { username: un, password: "pass1234" })).setCookie.split(";")[0];
  assert.equal((await req("GET", "/api/settings/llm", null, uCookie)).status, 403);
  assert.equal((await req("PUT", "/api/settings/llm", { api_key: "sk-hack-000000" }, uCookie)).status, 403);
  assert.equal((await req("POST", "/api/settings/llm/test", null, uCookie)).status, 403);

  await req("DELETE", "/api/users/" + cu.data.id, null, aCookie);
});

test("设置：连接测试失败给出可读错误，周报自动回退模板", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];
  await pool.query("DELETE FROM app_settings");
  await req("PUT", "/api/settings/llm", {
    api_key: "sk-bad-key-000000", base_url: "http://127.0.0.1:9/v1", model: "deepseek-chat",
  }, aCookie);

  const t = await req("POST", "/api/settings/llm/test", null, aCookie);
  assert.equal(t.status, 400);
  assert.ok(t.data.error.includes("模型调用失败"), "错误信息可读：" + t.data.error);
  assert.ok(!t.data.error.includes("sk-bad-key"), "错误信息不得包含密钥");

  // 大模型不可用时，周报仍能生成（回退模板）且带 warning
  const p = await req("POST", "/api/projects", { name: "回退测试项目" }, aCookie);
  const g = await req("POST", "/api/reports/generate", { project_id: p.data.id, week_start: "2026-10-26" }, aCookie);
  assert.equal(g.status, 200);
  assert.equal(g.data.source, "template");
  assert.ok(g.data.warning.includes("已改用本地模板"));

  await req("DELETE", "/api/projects/" + p.data.id, null, aCookie);
  const cleared = await req("DELETE", "/api/settings/llm", null, aCookie);
  assert.equal(cleared.data.configured, false);
});

/* ---------- 排期 WBS：阶段 / 任务 / 依赖 / 模板 / 进度联动 ---------- */
test("WBS：阶段与任务 CRUD、依赖校验、状态联动、模板倒排、模块进度重算、权限", async () => {
  if (!dbAvailable) return;
  const aLogin = await req("POST", "/api/login", { username: "tester", password: "test-pass-123" });
  const aCookie = aLogin.setCookie.split(";")[0];

  const p = await req("POST", "/api/projects", { name: "WBS排期测试" }, aCookie);
  const pid = p.data.id;

  // ---- 阶段 ----
  const ph = await req("POST", "/api/phases", { project_id: pid, name: "开发阶段", plan_start: "2026-11-02", plan_end: "2026-11-20" }, aCookie);
  assert.equal(ph.status, 201);
  const phId = ph.data.id;
  assert.equal((await req("POST", "/api/phases", { project_id: pid, name: "坏日期", plan_start: "2026-11-20", plan_end: "2026-11-01" }, aCookie)).status, 400);
  assert.equal((await req("POST", "/api/phases", { name: "缺项目" }, aCookie)).status, 400);
  // 合并语义：只改名字，日期保留
  await req("PUT", "/api/phases/" + phId, { name: "开发阶段2" }, aCookie);
  const phList = (await req("GET", "/api/phases?project_id=" + pid, null, aCookie)).data;
  assert.equal(phList.length, 1);
  assert.equal(phList[0].name, "开发阶段2");
  assert.equal(phList[0].plan_end, "2026-11-20", "PUT 未提交字段保留");

  // ---- 模块（进度来源 wbs）----
  const m = await req("POST", "/api/modules", { project_id: pid, name: "WBS模块", plan_date: "2026-11-25", status: "开发中", progress: 0, progress_source: "wbs" }, aCookie);
  assert.equal(m.status, 201);
  const mid = m.data.id;
  const modRow = (await req("GET", "/api/modules?project_id=" + pid, null, aCookie)).data.find(x => x.id === mid);
  assert.equal(modRow.progress_source, "wbs", "进度来源需真正入库");

  // ---- 任务 ----
  const mk = (name, extra) => Object.assign({ project_id: pid, phase_id: phId, module_id: mid, name, estimate_hours: 8 }, extra || {});
  const t1 = await req("POST", "/api/tasks", mk("需求确认", { plan_start: "2026-11-02", plan_end: "2026-11-03" }), aCookie);
  const t2 = await req("POST", "/api/tasks", mk("开发联调", { plan_start: "2026-11-04", plan_end: "2026-11-10", predecessor_id: t1.data.id }), aCookie);
  const t3 = await req("POST", "/api/tasks", mk("UAT测试", { plan_start: "2026-11-11", plan_end: "2026-11-14", predecessor_id: t2.data.id }), aCookie);
  assert.equal(t1.status, 201); assert.equal(t2.status, 201); assert.equal(t3.status, 201);

  // 校验：缺阶段 / 跨项目阶段 / 日期倒置 / 前置是自己
  assert.equal((await req("POST", "/api/tasks", { project_id: pid, module_id: mid, name: "缺阶段" }, aCookie)).status, 400);
  assert.equal((await req("POST", "/api/tasks", { project_id: pid, phase_id: 999999, name: "坏阶段" }, aCookie)).status, 400);
  assert.equal((await req("POST", "/api/tasks", mk("日期倒置", { plan_start: "2026-11-10", plan_end: "2026-11-01" }), aCookie)).status, 400);
  assert.equal((await req("PUT", "/api/tasks/" + t3.data.id, { predecessor_id: t3.data.id }, aCookie)).status, 400, "前置不能是自己");

  // 环检测：1←2←3，把 1 的前置设为 3 → 成环拒绝
  assert.equal((await req("PUT", "/api/tasks/" + t1.data.id, { predecessor_id: t3.data.id }, aCookie)).status, 400);

  // 状态↔进度联动：进度 100 → 已完成；已完成 → 进度强制 100 并补实际结束
  const done = await req("PUT", "/api/tasks/" + t1.data.id, { progress: 100 }, aCookie);
  assert.equal(done.status, 200);
  const t1row = (await req("GET", "/api/tasks?project_id=" + pid, null, aCookie)).data.find(t => t.id === t1.data.id);
  assert.equal(t1row.status, "已完成");
  assert.ok(t1row.actual_end, "已完成自动补实际结束日期");

  // ---- 模块进度按 WBS 加权重算（8/8/8 → 1/3 完成 ≈ 33）----
  const mod = (await req("GET", "/api/projects/" + pid, null, aCookie)); // 触发一次接口确保无异常
  const tasks = (await req("GET", "/api/tasks?project_id=" + pid, null, aCookie)).data;
  const w = tasks.reduce((s, t) => s + (t.estimate_hours > 0 ? t.estimate_hours : 1), 0);
  const weighted = Math.round(tasks.reduce((s, t) => s + (t.estimate_hours > 0 ? t.estimate_hours : 1) * t.progress, 0) / w);
  assert.ok(weighted > 0 && weighted <= 34, "加权进度 ≈ 33，实际 " + weighted);

  // ---- 模板清单与套用 ----
  const tpls = (await req("GET", "/api/tasks/templates", null, aCookie)).data;
  assert.ok(tpls.length >= 1 && tpls[0].items.length >= 3);
  const app1 = await req("POST", "/api/tasks/apply-template", { module_id: mid, template_key: tpls[0].key, launch_date: "2026-12-05", buffer_days: 2 }, aCookie);
  assert.equal(app1.status, 201);
  assert.ok(app1.data.created === tpls[0].items.length, "生成任务数=模板条目数");
  assert.ok(app1.data.phase_id, "自动建了阶段");
  // 倒排：最后一条任务 plan_end = 上线日 - buffer；且模板任务串成前置链
  const all = (await req("GET", "/api/tasks?project_id=" + pid, null, aCookie)).data.filter(t => t.phase_id === app1.data.phase_id);
  const last = all[all.length - 1];
  assert.equal(last.plan_end, "2026-12-03", "上线日-2 缓冲，实际 " + last.plan_end);
  assert.ok(all.slice(1).every(t => t.predecessor_id), "模板任务按顺序串成前置链");
  assert.ok(!all[0].predecessor_id, "首任务无前置");
  // 套用到没上线日期的模块且不给 launch_date → 报错
  const m2 = await req("POST", "/api/modules", { project_id: pid, name: "无日期模块" }, aCookie);
  assert.equal((await req("POST", "/api/tasks/apply-template", { module_id: m2.data.id, template_key: tpls[0].key }, aCookie)).status, 400);

  // ---- 权限：普通用户是任务负责人 → 可改执行字段，不可改计划 ----
  const suffix = Date.now().toString(36);
  const un = "wbs_" + suffix;
  const cu = await req("POST", "/api/users", { username: un, password: "pass1234", role: "user" }, aCookie);
  await req("PUT", "/api/tasks/" + t2.data.id, { owner_id: cu.data.id }, aCookie);
  const uCookie = (await req("POST", "/api/login", { username: un, password: "pass1234" })).setCookie.split(";")[0];
  // 我的任务可见（非项目成员）
  const mine = (await req("GET", "/api/tasks/my", null, uCookie)).data;
  assert.ok(mine.some(t => t.id === t2.data.id), "负责人在「我的任务」能看到");
  // 改执行字段 OK
  assert.equal((await req("PUT", "/api/tasks/" + t2.data.id, { status: "进行中", progress: 50 }, uCookie)).status, 200);
  // 改计划字段 → 403
  assert.equal((await req("PUT", "/api/tasks/" + t2.data.id, { plan_end: "2026-12-31" }, uCookie)).status, 403);
  // 与项目无关也非负责人的用户 → 403
  const un2 = "wbs2_" + suffix;
  const cu2 = await req("POST", "/api/users", { username: un2, password: "pass1234", role: "user" }, aCookie);
  const u2Cookie = (await req("POST", "/api/login", { username: un2, password: "pass1234" })).setCookie.split(";")[0];
  assert.equal((await req("PUT", "/api/tasks/" + t3.data.id, { status: "进行中" }, u2Cookie)).status, 403);
  assert.ok(!(await req("GET", "/api/tasks?project_id=" + pid, null, u2Cookie)).data.some(t => t.id === t3.data.id), "无关用户列表看不到");

  // ---- 删除级联 ----
  await req("DELETE", "/api/phases/" + app1.data.phase_id, null, aCookie);
  assert.equal(((await req("GET", "/api/tasks?project_id=" + pid, null, aCookie)).data.filter(t => t.phase_id === app1.data.phase_id)).length, 0, "删阶段级联删任务");

  await req("DELETE", "/api/projects/" + pid, null, aCookie);
  await req("DELETE", "/api/users/" + cu.data.id, null, aCookie);
  await req("DELETE", "/api/users/" + cu2.data.id, null, aCookie);
});
