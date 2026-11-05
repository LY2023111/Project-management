/* 周报纯函数单测：周区间计算 + 本地模板输出（不依赖数据库/网络） */
const test = require("node:test");
const assert = require("node:assert");
const { mondayOf, weekRange, addDays, buildTemplate, collectWeek } = require("../server/weekly");

test("周区间：任意日期落在周一至周日", () => {
  assert.equal(mondayOf("2026-11-02"), "2026-11-02"); // 周一
  assert.deepEqual(weekRange("2026-11-02"), { start: "2026-11-02", end: "2026-11-08" });
  assert.equal(mondayOf("2026-11-05"), "2026-11-02"); // 周四 → 本周一
  assert.equal(mondayOf("2026-11-08"), "2026-11-02"); // 周日 → 上周一
  assert.deepEqual(weekRange("2026-11-08"), { start: "2026-11-02", end: "2026-11-08" });
  assert.equal(addDays("2026-11-02", 7), "2026-11-09");
  // 跨月/跨年
  assert.deepEqual(weekRange("2026-12-31"), { start: "2026-12-28", end: "2027-01-03" });
});

/* 构造一份最小数据集，验证模板输出包含关键信息 */
function fixture() {
  return {
    project: { name: "郏县妇幼", code: "JX-01", owner: "张三", status: "进行中" },
    week_start: "2026-10-26", week_end: "2026-11-01", today: "2026-11-02",
    progress_avg: 55,
    modules: [
      { id: 1, name: "门诊模块", owner: "李四", status: "开发中", plan_date: "2026-11-20",
        progress_before: 30, progress_after: 50, delta: 20, has_week_update: true,
        week_updates: [{ date: "2026-10-28", progress: 50, note: "完成挂号功能" }], coord_note: "" },
      { id: 2, name: "住院模块", owner: "王五", status: "未开始", plan_date: "2026-10-20",
        progress_before: null, progress_after: 0, delta: null, has_week_update: false,
        week_updates: [], coord_note: "需要医院提供接口文档" },
    ],
    stats: { module_total: 2, module_updated: 1, issue_created: 1, issue_resolved: 0,
      issue_finished: 1, issue_open: 2, issue_overdue: 1, issue_waiting_test: 1 },
    created_issues: [{ type: "需求", title: "增加导出功能", status: "待处理", priority: "中",
      assignee: "李四", reporter: "张三", plan_date: "2026-11-06", actual_date: null, actual_hours: null, finish_note: "" }],
    resolved_issues: [],
    finished_issues: [{ type: "Bug", title: "登录报错", status: "已完成", priority: "高",
      assignee: "李四", reporter: "张三", plan_date: "2026-10-30", actual_date: "2026-10-30", actual_hours: 4, finish_note: "修复空指针" }],
    open_issues: [{ type: "Bug", title: "报表慢", status: "处理中", priority: "高",
      assignee: "李四", reporter: "张三", plan_date: "2026-10-01", actual_date: null, actual_hours: null, finish_note: "" }],
    milestones: [{ name: "部署", plan_date: "2026-10-30", actual_date: "2026-10-30", status: "已完成" }],
    next_week: { range: ["2026-11-02", "2026-11-08"], modules: [{ name: "门诊模块", plan_date: "2026-11-06", progress: 50 }], issues: [], milestones: [] },
    risks: ["模块「住院模块」计划上线 2026-10-20 已逾期（当前进度 0%）"],
    coord_items: [{ module: "住院模块", note: "需要医院提供接口文档" }],
    contracts: [{ name: "软件采购合同", code: "HT-1", amount: 128000 }],
  };
}

test("模板周报：包含项目、周期、模块进度、风险与下周计划", () => {
  const md = buildTemplate(fixture());
  assert.ok(md.includes("郏县妇幼"));
  assert.ok(md.includes("2026-10-26 至 2026-11-01"));
  assert.ok(md.includes("| 门诊模块 |"), "模块表格行");
  assert.ok(md.includes("30%") && md.includes("50%"), "上周/本周进度");
  assert.ok(md.includes("+20%"), "进度变化");
  assert.ok(md.includes("完成挂号功能"), "本周说明");
  assert.ok(md.includes("增加导出功能"), "新增需求");
  assert.ok(md.includes("修复空指针"), "完成状况");
  assert.ok(md.includes("已逾期"), "风险");
  assert.ok(md.includes("需协调"), "协调事项");
  assert.ok(md.includes("## 六、下周计划") && md.includes("门诊模块"), "下周计划");
});

test("模板周报：无数据时不报错、给出兜底文案", () => {
  const d = fixture();
  d.modules = []; d.created_issues = []; d.finished_issues = []; d.open_issues = [];
  d.milestones = []; d.risks = []; d.coord_items = []; d.contracts = [];
  d.next_week = { range: ["2026-11-02", "2026-11-08"], modules: [], issues: [], milestones: [] };
  const md = buildTemplate(d);
  assert.ok(md.includes("暂无上线模块"));
  assert.ok(md.includes("本周无新增或变更的问题/需求"));
  assert.ok(md.includes("本周无突出风险"));
  assert.ok(md.length > 100);
});

test("collectWeek 可被导入（供集成测试复用）", () => {
  assert.equal(typeof collectWeek, "function");
});
