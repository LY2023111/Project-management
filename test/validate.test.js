const test = require("node:test");
const assert = require("node:assert");
const { validateProject, validateModule, validateMilestone, validateIssue, validateUpdate } = require("../server/validate");
/* ---------- 项目 ---------- */
test("项目：名称必填", () => {
  const r = validateProject({ name: "  " });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("名称")));
});
test("项目：合法数据通过并归一化", () => {
  const r = validateProject({ name: " 客户中台 ", code: "ZT-01", owner: "我", status: "进行中", note: "" });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, "客户中台");
  assert.equal(r.value.status, "进行中");
});
test("项目：非法状态被拒绝", () => {
  assert.equal(validateProject({ name: "x", status: "瞎写" }).ok, false);
});
test("项目：状态缺省为筹备中", () => {
  const r = validateProject({ name: "x" });
  assert.equal(r.value.status, "筹备中");
});

/* ---------- 模块 ---------- */
test("模块：名称必填", () => {
  assert.equal(validateModule({ name: "" }).ok, false);
});
test("模块：进度必须是 0-100 的整数", () => {
  assert.equal(validateModule({ name: "a", progress: 101 }).ok, false);
  assert.equal(validateModule({ name: "a", progress: -5 }).ok, false);
  assert.equal(validateModule({ name: "a", progress: "abc" }).ok, false);
  const r = validateModule({ name: "a", progress: "45" });
  assert.equal(r.ok, true);
  assert.equal(r.value.progress, 45);
});
test("模块：非法上线情况被拒绝", () => {
  assert.equal(validateModule({ name: "a", status: "乱写的" }).ok, false);
});
test("模块：无法上线必须填原因", () => {
  assert.equal(validateModule({ name: "a", status: "无法上线", failReason: "" }).ok, false);
  const r = validateModule({ name: "a", status: "无法上线", failReason: "接口未就绪" });
  assert.equal(r.ok, true);
});
test("模块：非无法上线不要求原因", () => {
  assert.equal(validateModule({ name: "a", status: "试运行" }).ok, true);
});
test("模块：日期格式非法被拒绝", () => {
  assert.equal(validateModule({ name: "a", planDate: "2026/1/1" }).ok, false);
  const r = validateModule({ name: "a", planDate: "2026-01-01" });
  assert.equal(r.ok, true);
});
test("模块：日期允许为空", () => {
  assert.equal(validateModule({ name: "a", planDate: "", actualDate: "" }).ok, true);
});

/* ---------- 里程碑 ---------- */
test("里程碑：名称必填、状态枚举", () => {
  assert.equal(validateMilestone({ name: "" }).ok, false);
  assert.equal(validateMilestone({ name: "上线", status: "乱写" }).ok, false);
  assert.equal(validateMilestone({ name: "上线" }).value.status, "未开始");
});

/* ---------- 记录 ---------- */
test("记录：标题必填", () => {
  assert.equal(validateIssue({ type: "Bug", title: "" }).ok, false);
});
test("记录：类型/优先级/状态枚举", () => {
  assert.equal(validateIssue({ title: "t", type: "瞎写" }).ok, false);
  assert.equal(validateIssue({ title: "t", priority: "瞎写" }).ok, false);
  assert.equal(validateIssue({ title: "t", status: "瞎写" }).ok, false);
});
test("记录：合法数据通过且默认值正确", () => {
  const r = validateIssue({ title: "导出报错", type: "Bug", priority: "高" });
  assert.equal(r.ok, true);
  assert.equal(r.value.status, "待处理");
  assert.equal(r.value.priority, "高");
});

/* ---------- 下划线字段名兼容（前端提交 DB 风格字段名） ---------- */
test("模块：兼容 snake_case 字段名（coord_note/fail_reason/plan_date）", () => {
  const r = validateModule({ name: "a", status: "无法上线", fail_reason: "接口未就绪", coord_note: "需客户配合", plan_date: "2026-11-10" });
  assert.equal(r.ok, true);
  assert.equal(r.value.failReason, "接口未就绪");
  assert.equal(r.value.coordNote, "需客户配合");
  assert.equal(r.value.planDate, "2026-11-10");
});
test("模块：无法上线 + 只有 snake_case 原因也应通过", () => {
  const r = validateModule({ name: "a", status: "无法上线", fail_reason: "环境未开通" });
  assert.equal(r.ok, true);
});
test("里程碑：兼容 snake_case 字段名", () => {
  const r = validateMilestone({ name: "上线", plan_date: "2026-11-11", actual_date: "2026-11-12" });
  assert.equal(r.ok, true);
  assert.equal(r.value.planDate, "2026-11-11");
  assert.equal(r.value.actualDate, "2026-11-12");
});

/* ---------- 进度记录与甘特图时间窗 ---------- */
test("进度记录：日期必填、进度 0-100", () => {
  assert.equal(validateUpdate({ progress: 50 }).ok, false);            // 缺日期
  assert.equal(validateUpdate({ update_date: "2026-13-01" }).ok, false); // 日期格式
  const r = validateUpdate({ update_date: "2026-11-02", progress: 45, note: "本周完成审批流" });
  assert.equal(r.ok, true);
  assert.equal(r.value.updateDate, "2026-11-02");
  assert.equal(r.value.progress, 45);
});
test("进度记录：进度越界被拒、缺省为 0", () => {
  assert.equal(validateUpdate({ update_date: "2026-11-02", progress: 101 }).ok, false);
  assert.equal(validateUpdate({ update_date: "2026-11-02", progress: -1 }).ok, false);
  assert.equal(validateUpdate({ update_date: "2026-11-02" }).value.progress, 0);
});
test("模块：plan_start 与 plan_date 兼容驼峰/下划线", () => {
  const r = validateModule({ name: "a", plan_start: "2026-11-01", planDate: "2026-11-20" });
  assert.equal(r.ok, true);
  assert.equal(r.value.planStart, "2026-11-01");
  assert.equal(r.value.planDate, "2026-11-20");
});
test("模块：计划开始晚于计划上线被拒", () => {
  const r = validateModule({ name: "a", plan_start: "2026-11-20", plan_date: "2026-11-01" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("计划开始")));
});

/* ---------- 问题指派与流转字段 ---------- */
test("问题：兼容 snake_case 的指派/计划完成/工时/完成状况", () => {
  const r = validateIssue({
    title: "登录报错", assignee_id: 3, plan_date: "2026-11-10",
    actual_date: "2026-11-08", actual_hours: "6.5", finish_note: "已修复并自测通过",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.assigneeId, 3);
  assert.equal(r.value.planDate, "2026-11-10");
  assert.equal(r.value.actualHours, 6.5);
  assert.equal(r.value.finishNote, "已修复并自测通过");
});
test("问题：工时越界被拒、缺省为空", () => {
  assert.equal(validateIssue({ title: "a", actual_hours: -1 }).ok, false);
  assert.equal(validateIssue({ title: "a", actual_hours: 10000 }).ok, false);
  assert.equal(validateIssue({ title: "a" }).value.actualHours, undefined);
  assert.equal(validateIssue({ title: "a", actual_hours: "2.45" }).value.actualHours, 2.5);
});
test("问题：状态枚举包含已完成（待验收）", () => {
  const r = validateIssue({ title: "a", status: "已完成" });
  assert.equal(r.ok, true);
});
