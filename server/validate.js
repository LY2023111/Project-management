/* 纯函数校验层：不依赖 DB / Express，便于单元测试 */
const { PROJ_STATUS, MOD_STATUS, MS_STATUS, ISSUE_TYPES, ISSUE_STATUS, PRIORITIES, PHASE_STATUS, TASK_STATUS, DATE_RE } = require("./constants");

function s(v) { return (v == null ? "" : String(v)).trim(); }

/* 校验是否真实存在的日历日期（拒绝 2026-13-01、2026-02-30 等） */
function isRealDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/* 字段名归一化：兼容驼峰(coordNote)与下划线(coord_note)两种提交风格 */
const FIELD_ALIASES = {
  planDate: "plan_date", actualDate: "actual_date",
  failReason: "fail_reason", coordNote: "coord_note",
  planStart: "plan_start", updateDate: "update_date",
  assigneeId: "assignee_id", actualHours: "actual_hours", finishNote: "finish_note",
  signDate: "sign_date",
  projectId: "project_id", phaseId: "phase_id", moduleId: "module_id", ownerId: "owner_id",
  predecessorId: "predecessor_id", sortOrder: "sort_order",
  actualStart: "actual_start", actualEnd: "actual_end", estimateHours: "estimate_hours", planEnd: "plan_end",
  progressSource: "progress_source", bufferDays: "buffer_days", templateKey: "template_key",
};
function normalize(body) {
  if (!body) return body;
  const out = Object.assign({}, body);
  for (const [camel, snake] of Object.entries(FIELD_ALIASES)) {
    if (out[camel] === undefined && out[snake] !== undefined) out[camel] = out[snake];
    else if (out[snake] === undefined && out[camel] !== undefined) out[snake] = out[camel];
  }
  return out;
}

function baseValidator(body, rules) {
  body = normalize(body);
  const errors = [];
  const value = {};
  for (const [field, rule] of Object.entries(rules)) {
    let v = body ? body[field] : undefined;
    if (rule.type === "str") {
      v = s(v);
      if (rule.required && !v) { errors.push(rule.label + "必填"); continue; }
      if (rule.max && v.length > rule.max) { errors.push(rule.label + "不能超过 " + rule.max + " 字"); continue; }
      value[field] = v;
    } else if (rule.type === "enum") {
      v = s(v) || rule.def;
      if (!rule.list.includes(v)) { errors.push(rule.label + "不合法"); continue; }
      value[field] = v;
    } else if (rule.type === "date") {
      v = s(v);
      if (v && (!DATE_RE.test(v) || !isRealDate(v))) { errors.push(rule.label + "格式应为有效日期 YYYY-MM-DD"); continue; }
      if (rule.required && !v) { errors.push(rule.label + "必填"); continue; }
      value[field] = v || null;
    } else if (rule.type === "num") {
      if (v === "" || v == null) { value[field] = rule.def; continue; }
      const n = parseFloat(v);
      if (isNaN(n) || n < rule.min || n > rule.max) { errors.push(rule.label + "必须是 " + rule.min + "-" + rule.max + " 的数字"); continue; }
      value[field] = Math.round(n * 10) / 10;
    } else if (rule.type === "int") {
      const n = parseInt(v, 10);
      if (v === "" || v == null) { value[field] = rule.def; continue; }
      if (isNaN(n) || n < rule.min || n > rule.max) { errors.push(rule.label + "必须是 " + rule.min + "-" + rule.max + " 的整数"); continue; }
      value[field] = n;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

const projectRules = {
  name:   { type: "str", required: true, max: 100, label: "项目名称" },
  code:   { type: "str", max: 50, label: "项目编号" },
  owner:  { type: "str", max: 50, label: "负责人" },
  status: { type: "enum", list: PROJ_STATUS, def: "筹备中", label: "项目状态" },
  note:   { type: "str", max: 1000, label: "备注" },
};

const moduleRules = {
  name:      { type: "str", required: true, max: 100, label: "模块名称" },
  owner:     { type: "str", max: 50, label: "负责人" },
  planStart: { type: "date", label: "计划开始时间" },
  planDate:  { type: "date", label: "计划上线时间" },
  actualDate:{ type: "date", label: "实际上线时间" },
  status:    { type: "enum", list: MOD_STATUS, def: "未开始", label: "上线情况" },
  progress:  { type: "int", min: 0, max: 100, def: 0, label: "进度" },
  progressSource: { type: "enum", list: ["manual", "wbs"], def: "manual", label: "进度来源" },
  failReason:{ type: "str", max: 500, label: "无法上线原因" },
  coordNote: { type: "str", max: 500, label: "协调配合内容" },
  note:      { type: "str", max: 1000, label: "备注" },
};

const updateRules = {
  updateDate: { type: "date", required: true, label: "进度日期" },
  progress:   { type: "int", min: 0, max: 100, def: 0, label: "进度" },
  note:       { type: "str", max: 500, label: "进度说明" },
};

const milestoneRules = {
  name:      { type: "str", required: true, max: 50, label: "节点名称" },
  planDate:  { type: "date", label: "计划日期" },
  actualDate:{ type: "date", label: "实际完成日期" },
  status:    { type: "enum", list: MS_STATUS, def: "未开始", label: "状态" },
  note:      { type: "str", max: 1000, label: "备注" },
};

const issueRules = {
  type:        { type: "enum", list: ISSUE_TYPES, def: "问题", label: "类型" },
  title:       { type: "str", required: true, max: 200, label: "标题" },
  detail:      { type: "str", max: 2000, label: "详细说明" },
  owner:       { type: "str", max: 50, label: "负责人" },
  priority:    { type: "enum", list: PRIORITIES, def: "中", label: "优先级" },
  status:      { type: "enum", list: ISSUE_STATUS, def: "待处理", label: "状态" },
  assigneeId:  { type: "int", min: 1, max: 2000000000, label: "指派用户" },
  planDate:    { type: "date", label: "计划完成时间" },
  actualDate:  { type: "date", label: "实际完成时间" },
  actualHours: { type: "num", min: 0, max: 9999, label: "实际工时" },
  finishNote:  { type: "str", max: 1000, label: "完成状况" },
};

const contractRules = {
  name:     { type: "str", required: true, max: 200, label: "合同名称" },
  code:     { type: "str", max: 100, label: "合同编号" },
  party:    { type: "str", max: 200, label: "对方单位" },
  amount:   { type: "num", min: 0, max: 999999999999, label: "合同金额" },
  signDate: { type: "date", label: "签订日期" },
  note:     { type: "str", max: 1000, label: "备注" },
};

const phaseRules = {
  name:      { type: "str", required: true, max: 100, label: "阶段名称" },
  planStart: { type: "date", label: "阶段计划开始" },
  planEnd:   { type: "date", label: "阶段计划结束" },
  status:    { type: "enum", list: PHASE_STATUS, def: "未开始", label: "阶段状态" },
  sortOrder: { type: "int", min: 0, max: 9999, def: 0, label: "排序" },
  note:      { type: "str", max: 500, label: "备注" },
};

const taskRules = {
  name:          { type: "str", required: true, max: 200, label: "任务名称" },
  phaseId:       { type: "int", min: 1, max: 2000000000, label: "所属阶段" },
  moduleId:      { type: "int", min: 1, max: 2000000000, label: "关联模块" },
  ownerId:       { type: "int", min: 1, max: 2000000000, label: "负责人" },
  planStart:     { type: "date", label: "计划开始" },
  planEnd:       { type: "date", label: "计划结束" },
  actualStart:   { type: "date", label: "实际开始" },
  actualEnd:     { type: "date", label: "实际完成" },
  estimateHours: { type: "num", min: 0, max: 9999, label: "预估工时" },
  actualHours:   { type: "num", min: 0, max: 9999, label: "实际工时" },
  status:        { type: "enum", list: TASK_STATUS, def: "未开始", label: "任务状态" },
  progress:      { type: "int", min: 0, max: 100, def: 0, label: "进度" },
  predecessorId: { type: "int", min: 1, max: 2000000000, label: "前置任务" },
  sortOrder:     { type: "int", min: 0, max: 9999, def: 0, label: "排序" },
  note:          { type: "str", max: 500, label: "备注" },
};

function validateProject(body)  { return baseValidator(body, projectRules); }
function validateMilestone(body){ return baseValidator(body, milestoneRules); }
function validateIssue(body)    { return baseValidator(body, issueRules); }
function validateContract(body) { return baseValidator(body, contractRules); }

function validateModule(body) {
  const r = baseValidator(body, moduleRules);
  if (!r.ok) return r;
  if (r.value.status === "无法上线" && !r.value.failReason) {
    return { ok: false, errors: ["无法上线的模块必须填写原因"] };
  }
  // 甘特图时间窗：开始时间不能晚于上线时间
  const { planStart, planDate } = r.value;
  if (planStart && planDate && planStart > planDate) {
    return { ok: false, errors: ["计划开始时间不能晚于计划上线时间"] };
  }
  return r;
}

function validateUpdate(body) { return baseValidator(body, updateRules); }
function validatePhase(body)  { return baseValidator(body, phaseRules); }
function validateTask(body)   { return baseValidator(body, taskRules); }

module.exports = { validateProject, validateModule, validateMilestone, validateIssue, validateUpdate, validateContract, validatePhase, validateTask };
