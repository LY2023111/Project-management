/* 周报：按周聚合进度/问题/里程碑数据 → 大模型润色（未配密钥时用本地模板） */
const { resolveLlmConfig, chat } = require("./llm");

/* ---------- 日期工具（只处理 YYYY-MM-DD 字符串） ---------- */
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}
function ymd(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addDays(s, n) {
  const d = parseYmd(s);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return ymd(d);
}
/* 任意日期所在周的周一 */
function mondayOf(s) {
  const d = parseYmd(s) || new Date();
  const day = d.getDay(); // 0=周日
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return ymd(d);
}
function weekRange(s) {
  const start = mondayOf(s);
  return { start, end: addDays(start, 6) };
}
function nextWeekRange(start) {
  const ns = addDays(start, 7);
  return { start: ns, end: addDays(ns, 6) };
}
function fmtDate(s) { return s ? String(s).slice(0, 10) : "—"; }
function pct(n) { return n == null ? "—" : Math.round(n) + "%"; }
function num(n) { return Number(n || 0); }

/* ---------- 采集一周数据 ---------- */
async function collectWeek(pool, projectId, start, end) {
  const [[proj]] = await pool.query("SELECT * FROM projects WHERE id=?", [projectId]);
  const [modules] = await pool.query("SELECT * FROM modules WHERE project_id=? ORDER BY id", [projectId]);
  const [updates] = await pool.query(
    "SELECT * FROM module_updates WHERE project_id=? ORDER BY update_date, id", [projectId]);
  const [issues] = await pool.query(
    `SELECT i.*, ru.display_name AS reporter_name, au.display_name AS assignee_name
     FROM issues i
     LEFT JOIN users ru ON i.reporter_id = ru.id
     LEFT JOIN users au ON i.assignee_id = au.id
     WHERE i.project_id=? ORDER BY i.id`, [projectId]);
  const [milestones] = await pool.query(
    "SELECT * FROM milestones WHERE project_id=? ORDER BY sort_order, id", [projectId]);
  const [contracts] = await pool.query(
    "SELECT id, name, code, amount, sign_date, created_at FROM contracts WHERE project_id=? ORDER BY id", [projectId]);
  const [tasks] = await pool.query(
    `SELECT t.*, u.display_name AS owner_name, m.name AS module_name
     FROM tasks t
     LEFT JOIN users u ON t.owner_id = u.id
     LEFT JOIN modules m ON t.module_id = m.id
     WHERE t.project_id=? ORDER BY t.phase_id, t.sort_order, t.id`, [projectId]);

  const today = ymd(new Date());
  const inWeek = (d) => !!d && d >= start && d <= end;

  const mods = modules.map((m) => {
    const list = updates.filter((u) => u.module_id === m.id); // 已按日期升序
    const before = list.filter((u) => u.update_date < start).pop() || null;
    const weekList = list.filter((u) => inWeek(u.update_date));
    const afterEnd = list.filter((u) => u.update_date <= end).pop() || null;
    const progressAfter = afterEnd ? afterEnd.progress : (before ? before.progress : m.progress);
    const progressBefore = before ? before.progress : null;
    return {
      id: m.id, name: m.name, owner: m.owner, status: m.status,
      plan_start: m.plan_start, plan_date: m.plan_date, actual_date: m.actual_date,
      coord_note: m.coord_note, fail_reason: m.fail_reason,
      progress_before: progressBefore,
      progress_after: progressAfter,
      delta: progressBefore == null ? null : progressAfter - progressBefore,
      week_updates: weekList.map((u) => ({ date: u.update_date, progress: u.progress, note: u.note || "" })),
      has_week_update: weekList.length > 0,
    };
  });

  const progressAvg = mods.length ? Math.round(mods.reduce((s, m) => s + num(m.progress_after), 0) / mods.length) : 0;

  const createdIssues = issues.filter((i) => inWeek(String(i.created_at || "").slice(0, 10)));
  const resolvedIssues = issues.filter((i) => inWeek(String(i.resolved_at || "").slice(0, 10)));
  const finishedIssues = issues.filter((i) => inWeek(i.actual_date));
  const openIssues = issues.filter((i) => i.status !== "已解决");
  const overdueIssues = openIssues.filter((i) => i.plan_date && i.plan_date < today);
  const waitingTest = issues.filter((i) => i.status === "已完成");

  const pickIssue = (i) => ({
    type: i.type, title: i.title, status: i.status, priority: i.priority,
    assignee: i.assignee_name || i.owner || "", reporter: i.reporter_name || "",
    plan_date: i.plan_date, actual_date: i.actual_date,
    actual_hours: i.actual_hours == null ? null : num(i.actual_hours),
    finish_note: i.finish_note || "",
  });

  const weekMilestones = milestones.filter((m) => inWeek(m.plan_date) || inWeek(m.actual_date));
  const next = nextWeekRange(start);
  const nextMilestones = milestones.filter((m) => inWeek2(m.plan_date, next.start, next.end));
  const nextModules = mods.filter((m) => inWeek2(m.plan_date, next.start, next.end) && m.status !== "已上线");
  const nextIssues = openIssues.filter((i) => inWeek2(i.plan_date, next.start, next.end));

  const weekContracts = contracts.filter((c) => inWeek(String(c.created_at || "").slice(0, 10)));

  /* WBS 任务：逾期 / 本周到期 / 下周到期；模块 WBS 完成度 */
  const activeTasks = tasks.filter((t) => t.status !== "已取消");
  const openTasks = activeTasks.filter((t) => t.status !== "已完成");
  const lateTasks = openTasks.filter((t) => t.plan_end && t.plan_end < today);
  const dueTasks = openTasks.filter((t) => inWeek(t.plan_end));
  const finishedWeekTasks = activeTasks.filter((t) => t.status === "已完成" && inWeek(t.actual_end));
  const pickTask = (t) => ({
    name: t.name, module: t.module_name || "", owner: t.owner_name || "未指派",
    plan_end: t.plan_end, status: t.status, progress: t.progress,
  });
  const taskWeighted = (moduleId) => {
    const list = activeTasks.filter((t) => t.module_id === moduleId);
    if (!list.length) return null;
    let w = 0, s = 0;
    list.forEach((t) => {
      const wi = Number(t.estimate_hours) > 0 ? Number(t.estimate_hours) : 1;
      w += wi; s += wi * (Number(t.progress) || 0);
    });
    return w ? Math.round(s / w) : null;
  };
  const nextTasks = openTasks.filter((t) => inWeek2(t.plan_end, next.start, next.end));
  mods.forEach((m) => { m.task_weighted = taskWeighted(m.id); });

  /* 风险与需协调 */
  const risks = [];
  mods.forEach((m) => {
    if (m.status === "无法上线") risks.push(`模块「${m.name}」当前无法上线：${m.fail_reason || "未填写原因"}`);
    if (m.status !== "已上线" && m.plan_date && m.plan_date < today) {
      risks.push(`模块「${m.name}」计划上线 ${m.plan_date} 已逾期（当前进度 ${pct(m.progress_after)}）`);
    }
    if (!m.has_week_update && m.status !== "已上线") {
      risks.push(`模块「${m.name}」本周无进度更新（当前进度 ${pct(m.progress_after)}）`);
    }
  });
  overdueIssues.forEach((i) => {
    risks.push(`${i.type}「${i.title}」计划完成 ${i.plan_date} 已逾期，处理人：${i.assignee_name || i.owner || "未指派"}`);
  });
  lateTasks.slice(0, 6).forEach((t) => {
    risks.push(`任务「${t.name}」${t.module_name ? "（" + t.module_name + "）" : ""}计划 ${t.plan_end} 完成已逾期，负责人：${t.owner_name || "未指派"}`);
  });
  waitingTest.forEach((i) => {
    risks.push(`${i.type}「${i.title}」已完成待测试，请提交人 ${i.reporter_name || "—"} 验证`);
  });
  const coordItems = mods.filter((m) => m.coord_note).map((m) => ({ module: m.name, note: m.coord_note }));

  return {
    project: { name: proj ? proj.name : "", code: proj ? proj.code : "", owner: proj ? proj.owner : "", status: proj ? proj.status : "" },
    week_start: start, week_end: end, today,
    progress_avg: progressAvg,
    modules: mods,
    stats: {
      module_total: mods.length,
      module_updated: mods.filter((m) => m.has_week_update).length,
      issue_created: createdIssues.length,
      issue_resolved: resolvedIssues.length,
      issue_finished: finishedIssues.length,
      issue_open: openIssues.length,
      issue_overdue: overdueIssues.length,
      issue_waiting_test: waitingTest.length,
      task_total: activeTasks.length,
      task_open: openTasks.length,
      task_late: lateTasks.length,
      task_due_week: dueTasks.length,
      task_finished_week: finishedWeekTasks.length,
      wbs_progress: (() => {
        if (!activeTasks.length) return null;
        let w = 0, s = 0;
        activeTasks.forEach((t) => {
          const wi = Number(t.estimate_hours) > 0 ? Number(t.estimate_hours) : 1;
          w += wi; s += wi * (Number(t.progress) || 0);
        });
        return w ? Math.round(s / w) : null;
      })(),
    },
    created_issues: createdIssues.map(pickIssue),
    resolved_issues: resolvedIssues.map(pickIssue),
    finished_issues: finishedIssues.map(pickIssue),
    open_issues: openIssues.slice(0, 12).map(pickIssue),
    late_tasks: lateTasks.slice(0, 10).map(pickTask),
    due_tasks: dueTasks.slice(0, 10).map(pickTask),
    finished_tasks: finishedWeekTasks.slice(0, 10).map(pickTask),
    milestones: weekMilestones.map((m) => ({ name: m.name, plan_date: m.plan_date, actual_date: m.actual_date, status: m.status })),
    next_week: {
      range: [next.start, next.end],
      modules: nextModules.map((m) => ({ name: m.name, plan_date: m.plan_date, progress: m.progress_after })),
      issues: nextIssues.map(pickIssue),
      milestones: nextMilestones.map((m) => ({ name: m.name, plan_date: m.plan_date, status: m.status })),
      tasks: nextTasks.map(pickTask),
    },
    risks: risks.slice(0, 12),
    coord_items: coordItems,
    contracts: weekContracts.map((c) => ({ name: c.name, code: c.code, amount: c.amount == null ? null : num(c.amount) })),
  };
}
function inWeek2(d, s, e) { return !!d && d >= s && d <= e; }

/* ---------- 本地模板（无大模型可用时的兜底，也作为周报骨架） ---------- */
function buildTemplate(d) {
  const L = [];
  L.push(`# ${d.project.name} 项目周报`);
  L.push(`**周期：${d.week_start} 至 ${d.week_end}**`);
  L.push("");
  L.push("## 一、本周概览");
  L.push(`- 项目整体进度：${d.progress_avg}%（${d.stats.module_total} 个上线模块平均）`);
  L.push(`- 本周有进度更新的模块：${d.stats.module_updated} / ${d.stats.module_total}`);
  L.push(`- 问题与需求：新增 ${d.stats.issue_created} 条，完成 ${d.stats.issue_finished} 条，当前未完结 ${d.stats.issue_open} 条`);
  if (d.stats.task_total > 0) {
    L.push(`- WBS 任务：共 ${d.stats.task_total} 个，未完成 ${d.stats.task_open}，本周完成 ${d.stats.task_finished_week}，逾期 ${d.stats.task_late}，本周到期 ${d.stats.task_due_week}${d.stats.wbs_progress != null ? `，总体完成 ${d.stats.wbs_progress}%` : ""}`);
  }
  if (d.milestones.length) {
    L.push(`- 本周里程碑：${d.milestones.map((m) => `${m.name}（${m.status}${m.actual_date ? " " + m.actual_date : ""}）`).join("、")}`);
  } else {
    L.push("- 本周里程碑：无节点到期");
  }
  if (d.contracts.length) L.push(`- 本周新增合同：${d.contracts.map((c) => c.name).join("、")}`);

  L.push("");
  L.push("## 二、模块进展");
  const hasWbs = d.modules.some((m) => m.task_weighted != null);
  if (!d.modules.length) {
    L.push("暂无上线模块。");
  } else {
    L.push(hasWbs
      ? "| 模块 | 状态 | 上周进度 | 本周进度 | 变化 | WBS | 本周说明 |"
      : "| 模块 | 状态 | 上周进度 | 本周进度 | 变化 | 本周说明 |");
    L.push("| --- | --- | --- | --- | --- |" + (hasWbs ? " --- |" : ""));
    d.modules.forEach((m) => {
      const notes = m.week_updates.filter((u) => u.note).map((u) => `${u.date.slice(5)} ${u.note}`).join("；")
        || (m.has_week_update ? "已更新进度" : "本周无更新");
      const delta = m.delta == null ? "—" : (m.delta > 0 ? "+" + m.delta + "%" : m.delta + "%");
      const wbs = hasWbs ? ` ${pct(m.task_weighted)} |` : "";
      L.push(`| ${m.name} | ${m.status} | ${pct(m.progress_before)} | ${pct(m.progress_after)} | ${delta} |${wbs} ${notes.replace(/\|/g, "/")} |`);
    });
  }

  L.push("");
  L.push("## 三、问题与需求");
  if (!d.created_issues.length && !d.finished_issues.length && !d.open_issues.length) {
    L.push("本周无新增或变更的问题/需求。");
  } else {
    if (d.created_issues.length) {
      L.push(`**本周新增（${d.created_issues.length} 条）**`);
      d.created_issues.forEach((i) => L.push(`- [${i.type}] ${i.title}｜优先级 ${i.priority}｜处理人 ${i.assignee || "未指派"}${i.plan_date ? "｜计划 " + i.plan_date : ""}`));
    }
    if (d.finished_issues.length) {
      L.push("");
      L.push(`**本周完成（${d.finished_issues.length} 条）**`);
      d.finished_issues.forEach((i) => L.push(`- [${i.type}] ${i.title}｜处理人 ${i.assignee || "—"}${i.actual_hours != null ? "｜工时 " + i.actual_hours + "h" : ""}${i.finish_note ? "｜" + i.finish_note : ""}`));
    }
    if (d.open_issues.length) {
      L.push("");
      L.push(`**仍未完结（${d.stats.issue_open} 条，列出前 ${d.open_issues.length} 条）**`);
      d.open_issues.forEach((i) => L.push(`- [${i.type}] ${i.title}｜${i.status}｜处理人 ${i.assignee || "未指派"}${i.plan_date ? "｜计划 " + i.plan_date : ""}`));
    }
  }

  L.push("");
  L.push("## 四、里程碑");
  if (!d.milestones.length) {
    L.push("本周无里程碑节点到期。");
  } else {
    d.milestones.forEach((m) => L.push(`- ${m.name}：计划 ${fmtDate(m.plan_date)}${m.actual_date ? "，实际完成 " + m.actual_date : ""}，状态 ${m.status}`));
  }

  L.push("");
  L.push("## 五、风险与需协调事项");
  if (!d.risks.length && !d.coord_items.length) {
    L.push("本周无突出风险。");
  } else {
    d.risks.forEach((r, i) => L.push(`${i + 1}. ${r}`));
    d.coord_items.forEach((c) => L.push(`- 模块「${c.module}」需协调：${c.note}`));
  }

  L.push("");
  L.push("## 六、下周计划");
  const nw = d.next_week || {};
  const nwTasks = nw.tasks || [];
  const planLines = [];
  nw.modules.forEach((m) => planLines.push(`模块「${m.name}」计划 ${m.plan_date} 上线（当前 ${pct(m.progress)}）`));
  nw.milestones.forEach((m) => planLines.push(`里程碑「${m.name}」计划 ${m.plan_date}`));
  nw.issues.forEach((i) => planLines.push(`${i.type}「${i.title}」计划完成 ${i.plan_date}（处理人 ${i.assignee || "未指派"}）`));
  (nw.tasks || []).forEach((t) => planLines.push(`任务「${t.name}」${t.module ? "（" + t.module + "）" : ""}计划 ${t.plan_end} 完成（负责人 ${t.owner}）`));
  if (planLines.length) planLines.forEach((x) => L.push(`- ${x}`));
  else L.push(`- 继续推进各模块开发与测试（${nw.range[0]} 至 ${nw.range[1]} 暂无计划节点，建议补充计划时间）`);

  return L.join("\n");
}

/* ---------- 大模型提示词 ---------- */
function buildMessages(d) {
  const facts = {
    项目: d.project,
    周期: `${d.week_start} 至 ${d.week_end}`,
    整体进度: d.progress_avg + "%",
    统计: d.stats,
    模块进展: d.modules.map((m) => ({
      模块: m.name, 状态: m.status, 负责人: m.owner,
      上周进度: m.progress_before, 本周进度: m.progress_after,
      计划上线: m.plan_date,
      本周记录: m.week_updates,
    })),
    本周新增问题: d.created_issues,
    本周完成问题: d.finished_issues,
    仍未完结问题: d.open_issues,
    本周里程碑: d.milestones,
    风险: d.risks,
    需协调: d.coord_items,
    本周新增合同: d.contracts,
    WBS任务: {
      总数: d.stats.task_total, 未完成: d.stats.task_open, 逾期: d.stats.task_late,
      本周到期: d.stats.task_due_week, 本周完成: d.stats.task_finished_week,
      总体完成: d.stats.wbs_progress != null ? d.stats.wbs_progress + "%" : null,
      逾期任务: d.late_tasks, 本周到期任务: d.due_tasks, 本周完成任务: d.finished_tasks,
    },
    下周计划: d.next_week,
  };
  const system = [
    "你是一名资深项目经理助理，负责把零散的项目进度数据整理成结构清晰、可直接发给领导或客户的中文项目周报。",
    "硬性要求：",
    "1. 只能使用用户提供的数据，严禁编造、推测或补充未提供的数字、人名、日期。",
    "2. 所有百分比、条数必须与数据一致。",
    "3. 用 Markdown 输出，不要用一级标题（#），从二级标题（##）开始，不要包裹代码块。",
    "4. 语气客观简洁，避免空话套话；风险要写清楚影响和建议动作。",
    "5. 篇幅控制在 400-700 字。",
  ].join("\n");
  const user = [
    "以下是本周的项目数据（JSON）：",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
    "请输出包含以下章节的周报：",
    "## 一、本周概览（整体进度、关键数据，2-4 条）",
    "## 二、模块进展（用 Markdown 表格：模块/本周进度/变化/主要工作，只列本周有更新或状态异常的模块，其余一句话带过）",
    "## 三、问题与需求（新增、完成、待处理分组，突出逾期与高风险项）",
    "## 四、里程碑（本周节点状态）",
    "## 五、风险与需协调事项（逐条编号，写清影响与建议动作；重点覆盖逾期 WBS 任务；没有则写“本周无突出风险”）",
    "## 六、下周计划（按模块/问题/里程碑/WBS 任务列出）",
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/* ---------- 生成周报（大模型优先，失败回退模板） ---------- */
async function generateWeeklyReport(pool, env, projectId, weekStartInput, userId) {
  const { start, end } = weekRange(weekStartInput);
  const data = await collectWeek(pool, projectId, start, end);
  let content = "";
  let source = "template";
  let model = "";
  let warning = "";
  const cfg = await resolveLlmConfig(pool, env);
  if (cfg.ready) {
    try {
      const r = await chat(cfg, buildMessages(data));
      content = r.text;
      model = r.model;
      source = "llm";
    } catch (e) {
      warning = e.message + "，已改用本地模板生成";
      content = buildTemplate(data);
    }
  } else {
    warning = "未配置大模型密钥（在「用户管理 → 大模型设置」里录入即可），本次使用本地模板生成";
    content = buildTemplate(data);
  }
  const footer = source === "llm"
    ? `\n\n---\n_本报告由大模型（${model || "LLM"}）依据 ${start} ~ ${end} 的进度记录自动生成，请人工核对后使用。_`
    : `\n\n---\n_本报告由本地模板依据 ${start} ~ ${end} 的进度记录自动生成（未调用大模型）。_`;
  return { content: content + footer, source, model, warning, week_start: start, week_end: end, data };
}

module.exports = {
  parseYmd, ymd, addDays, mondayOf, weekRange, nextWeekRange,
  collectWeek, buildTemplate, buildMessages, generateWeeklyReport,
};
