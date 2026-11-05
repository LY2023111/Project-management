/* WBS 纯函数单测：环检测、加权进度、模板倒排（TDD：先红后绿） */
const test = require("node:test");
const assert = require("node:assert");
const { detectCycle, calcModuleProgress, expandTemplate, TEMPLATES } = require("../server/wbs");

/* ---------- detectCycle：沿 predecessor 链判断是否会成环 ---------- */
test("环检测：直链/长链不成环，成环与自环返回 true", () => {
  const tasks = [
    { id: 1, project_id: 10, predecessor_id: null },
    { id: 2, project_id: 10, predecessor_id: 1 },
    { id: 3, project_id: 10, predecessor_id: 2 },
    { id: 4, project_id: 10, predecessor_id: 3 },
  ];
  // 给 2 设前置 4：1←2←3←4。语义：新前置链上若经过自己才是环
  assert.equal(detectCycle(tasks, 2, 4), true, "下游任务设为前置，链绕回自己");
  assert.equal(detectCycle(tasks, 1, 4), true, "链头指回链尾成环");
  assert.equal(detectCycle(tasks, 1, 1), true, "自环");
  assert.equal(detectCycle(tasks, 1, null), false, "无前置");
  assert.equal(detectCycle(tasks, 4, 2), false, "前置链不经过自己，不构成环");
  assert.equal(detectCycle(tasks, 4, 1), false, "同上");
  assert.equal(detectCycle(tasks, 2, 1), false, "原有正常链");
});

test("环检测：前置不存在/跨项目/空任务不误报", () => {
  const tasks = [
    { id: 1, project_id: 10, predecessor_id: null },
    { id: 2, project_id: 10, predecessor_id: 1 },
  ];
  assert.equal(detectCycle(tasks, 2, 999), false, "前置不存在（新建任务场景）");
  assert.equal(detectCycle([], 1, 2), false, "空列表");
  assert.equal(detectCycle(tasks, 2, 3), false, "前置是别的项目的任务时按不存在处理");
});

/* ---------- calcModuleProgress：按工时加权 ---------- */
test("加权进度：空/null 返回 null，按 estimate_hours 加权取整", () => {
  assert.equal(calcModuleProgress([]), null);
  assert.equal(calcModuleProgress(null), null);

  assert.equal(calcModuleProgress([
    { estimate_hours: 8, progress: 50, status: "进行中" },
    { estimate_hours: 2, progress: 100, status: "已完成" },
  ]), 60, "(8*50+2*100)/10=60");

  assert.equal(calcModuleProgress([
    { estimate_hours: null, progress: 30, status: "进行中" },
    { estimate_hours: 0, progress: 90, status: "进行中" },
  ]), 60, "空权重按 1：(30+90)/2=60");

  assert.equal(calcModuleProgress([
    { estimate_hours: 5, progress: 40, status: "进行中" },
    { estimate_hours: 5, progress: 80, status: "进行中" },
  ]), 60, "四舍五入取整");
});

test("加权进度：已取消任务不参与计算", () => {
  assert.equal(calcModuleProgress([
    { estimate_hours: 8, progress: 100, status: "已完成" },
    { estimate_hours: 8, progress: 0, status: "已取消" },
  ]), 100, "取消的任务剔除");
});

/* ---------- expandTemplate：按上线日倒排 ---------- */
test("模板倒排：从上线日减缓冲往回排，自然日连续", () => {
  const out = expandTemplate(
    { key: "std", items: [
      { name: "需求确认", days: 2 },
      { name: "开发实现", days: 5 },
      { name: "UAT 测试", days: 3 },
      { name: "上线", days: 1 },
    ]},
    "2026-11-20", 0
  );
  assert.equal(out.length, 4);
  // 最后一个任务 end=上线日
  assert.equal(out[3].plan_end, "2026-11-20");
  assert.equal(out[3].plan_start, "2026-11-20");
  // 前任务 end = 后任务 start - 1 天
  assert.equal(out[2].plan_end, "2026-11-19");
  assert.equal(out[2].plan_start, "2026-11-17"); // 3 天：17,18,19
  assert.equal(out[1].plan_end, "2026-11-16");
  assert.equal(out[1].plan_start, "2026-11-12"); // 5 天：12-16
  assert.equal(out[0].plan_end, "2026-11-11");
  assert.equal(out[0].plan_start, "2026-11-10"); // 2 天
});

test("模板倒排：缓冲天数生效、跨月正确、非法日期报错", () => {
  const out = expandTemplate(
    { key: "x", items: [
      { name: "A", days: 1 },
      { name: "B", days: 2 },
    ]},
    "2026-12-01", 3
  );
  assert.equal(out[1].plan_end, "2026-11-28", "上线日-3 缓冲");
  assert.equal(out[1].plan_start, "2026-11-27");
  assert.equal(out[0].plan_end, "2026-11-26", "前任务 end = 后任务 start-1");
  assert.equal(out[0].plan_start, "2026-11-26");

  assert.throws(() => expandTemplate({ key: "x", items: [] }, "2026-13-01", 0), /日期/);
  assert.throws(() => expandTemplate({ key: "x", items: [] }, "", 0), /日期/);
});

test("内置模板：标准上线 7 任务、轻量上线 4 任务，顺序首任务在前", () => {
  assert.equal(TEMPLATES.std.items.length, 7);
  assert.equal(TEMPLATES.lite.items.length, 4);
  assert.ok(TEMPLATES.std.items[0].name.includes("需求"));
  assert.ok(TEMPLATES.std.key && TEMPLATES.lite.key);
  TEMPLATES.std.items.forEach((i) => assert.ok(i.days > 0 && i.name));
});
