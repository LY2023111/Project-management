/* WBS 纯函数：环检测、加权进度、模板倒排（不碰数据库，便于单测） */

/* ---------- 环检测：把 taskId 的前置改为 predecessorId 后，沿链向上是否会回到自己 ---------- */
function detectCycle(tasks, taskId, predecessorId) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let cur = predecessorId;
  const seen = new Set();
  while (cur != null) {
    if (cur === taskId) return true;          // 绕回自己 → 成环
    if (seen.has(cur)) return true;           // 链上本身有环，保险
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) return false;                     // 前置不存在（含跨项目）→ 按无环处理，由调用方拒绝
    cur = t.predecessor_id;
  }
  return false;
}

/* ---------- 模块进度：任务按预估工时加权平均；空/全取消返回 null ---------- */
function calcModuleProgress(tasks) {
  const list = (tasks || []).filter((t) => t.status !== "已取消");
  if (!list.length) return null;
  let wSum = 0, pSum = 0;
  list.forEach((t) => {
    const w = Number(t.estimate_hours) > 0 ? Number(t.estimate_hours) : 1;
    wSum += w;
    pSum += w * (Number(t.progress) || 0);
  });
  if (!wSum) return null;
  return Math.round(pSum / wSum);
}

/* ---------- 日期工具（本地时区，YYYY-MM-DD） ---------- */
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}
function fmt(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/* ---------- 模板倒排：最后一个任务结束 = 上线日 - 缓冲；前任务 end = 后任务 start - 1 ---------- */
function expandTemplate(template, launchDate, bufferDays) {
  const launch = parseYmd(launchDate);
  if (!launch) throw new Error("上线日期格式应为 YYYY-MM-DD");
  const buf = Math.max(0, Number(bufferDays) || 0);
  const items = (template && template.items) || [];
  const out = [];
  let nextEnd = addDays(launch, -buf); // 最后一个任务的 plan_end
  for (let i = items.length - 1; i >= 0; i--) {
    const days = Math.max(1, Math.ceil(Number(items[i].days) || 1)); // 0.5d 按 1 天占位
    const end = nextEnd;
    const start = addDays(end, -(days - 1));
    out.unshift({ name: items[i].name, days, plan_start: fmt(start), plan_end: fmt(end) });
    nextEnd = addDays(start, -1);
  }
  return out;
}

/* ---------- 内置模板 ---------- */
const TEMPLATES = {
  std: {
    key: "std",
    name: "标准上线",
    items: [
      { name: "需求确认", days: 2 },
      { name: "方案设计", days: 1 },
      { name: "开发实现", days: 5 },
      { name: "内部联调", days: 2 },
      { name: "UAT 测试", days: 3 },
      { name: "数据迁移", days: 1 },
      { name: "上线与培训支持", days: 1 },
    ],
  },
  lite: {
    key: "lite",
    name: "轻量上线",
    items: [
      { name: "需求确认", days: 1 },
      { name: "开发实现", days: 3 },
      { name: "测试验证", days: 1 },
      { name: "上线支持", days: 1 },
    ],
  },
};

module.exports = { detectCycle, calcModuleProgress, expandTemplate, TEMPLATES };
