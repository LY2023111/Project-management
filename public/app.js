"use strict";
/* ================= 常量 ================= */
const MS_TYPES = ["部署","测试","培训","上线","验收"];
const PROJ_STATUS = ["筹备中","进行中","已上线","已验收","暂停"];
const MOD_STATUS = ["未开始","开发中","测试中","试运行","已上线","无法上线"];
const ISSUE_TYPES = ["问题","协调","Bug","需求"];
const ISSUE_STATUS = ["待处理","处理中","已完成","已解决"];
const PRIORITY = ["高","中","低"];
const FILE_CATEGORIES = ["培训签到单","上线确认单","模块验收报告","测试报告","操作手册","其他"];
const REQUIRED_FILE_CATEGORIES = ["培训签到单","上线确认单","模块验收报告"];

let state = {
  projects:[], modules:[], milestones:[], issues:[], updates:[], contracts:[], phases:[], tasks:[], moduleFiles:[], issueProjects:[], assignees:[],
  ui:{ tab:"overview", projId:null, issueProj:"all", issueType:"all", issueStatus:"all", issueMine:"all", ganttProj:null, ganttZoom:1, ctProj:"all", reportProj:null, reportWeek:null, schedProj:null, ganttShowTasks:true, fileMod:null }
};

/* ================= API 层 ================= */
async function api(path, opts={}){
  const r = await fetch(path, Object.assign({ headers:{ "Content-Type":"application/json" } }, opts));
  if(r.status === 401){ currentUser=null; applyUser(); showLogin(); throw new Error("未登录或会话已过期"); }
  const d = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error || ("请求失败("+r.status+")"));
  return d;
}
async function refresh(){
  const d = await api("/api/bootstrap");
  state.projects = d.projects || []; state.modules = d.modules || [];
  state.milestones = d.milestones || []; state.issues = d.issues || [];
  state.updates = d.updates || [];
  state.contracts = d.contracts || [];
  state.phases = d.phases || [];
  state.tasks = d.tasks || [];
  state.moduleFiles = d.moduleFiles || [];
  state.issueProjects = d.issueProjects || [];
  if(state.ui.projId && !getProj(state.ui.projId)) state.ui.projId = null;
  if(state.ui.issueProj !== "all" && !getProj(state.ui.issueProj)) state.ui.issueProj = "all";
  hideLogin();
  render();
}
function markSaved(){ const t=document.getElementById("syncText"); if(t) t.textContent="已保存到 MySQL · "+new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}); }

/* ================= 工具 ================= */
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function fmt(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function todayStr(){ return fmt(new Date()); }
function dstr(off){ const d=new Date(); d.setDate(d.getDate()+off); return fmt(d); }
function parseDate(s){ if(!s) return null; const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m? new Date(+m[1],+m[2]-1,+m[3]) : null; }
function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function pct(n){ return Math.max(0,Math.min(100,Math.round(n||0))); }

/* ================= 查询/统计 ================= */
function getProj(pid){ return state.projects.find(p=>p.id===pid); }
function projModules(pid){ return state.modules.filter(m=>m.project_id===pid); }
function projMilestones(pid){ return state.milestones.filter(m=>m.project_id===pid); }
function projIssues(pid){ return state.issues.filter(i=>i.project_id===pid); }
function projProgress(pid){
  const ms=projModules(pid); if(!ms.length) return 0;
  return pct(ms.reduce((s,m)=>s+pct(m.progress),0)/ms.length);
}
function projOpenIssues(pid){ return projIssues(pid).filter(i=>i.status!=="已解决").length; }
function modUpdates(mid){ return state.updates.filter(u=>u.module_id===mid); }
/* 模块交付附件（培训签到单/上线确认单/模块验收报告等） */
function modFiles(mid){ return state.moduleFiles.filter(f=>f.module_id===mid); }
function fileChips(mid, status){
  const list = modFiles(mid);
  if(!list.length && status!=="已上线") return "";
  const chips = REQUIRED_FILE_CATEGORIES.map(c=>{
    const n = list.filter(f=>f.category===c).length;
    return `<span class="fchip ${n?"ok":"miss"}">${n?"✓":"○"} ${c}${n>1?" ×"+n:""}</span>`;
  }).join("");
  const extra = list.filter(f=>!REQUIRED_FILE_CATEGORIES.includes(f.category)).length;
  return `<div class="fchips">${chips}${extra?`<span class="fchip more">其他 ${extra}</span>`:""}
    <span class="muted" style="font-size:12px">共 ${list.length} 个附件</span></div>`;
}
function modLatestUpdate(mid){
  const us=modUpdates(mid);
  return us.length? us.reduce((a,b)=> (a.update_date>b.update_date||(a.update_date===b.update_date&&a.id>b.id))?a:b) : null;
}
function issueProj(pid){ return getProj(pid) || state.issueProjects.find(p=>p.id===pid); }
async function loadAssignees(force){
  if(state.assignees.length && !force) return;
  state.assignees = await api("/api/assignees");
}
function msState(m){
  if(m.status==="已完成") return "done";
  if(m.status==="进行中") return "doing";
  const pd=parseDate(m.plan_date), now=new Date(); now.setHours(0,0,0,0);
  if(pd && pd<now) return "late";
  return "todo";
}
function msIcon(m){
  const s=msState(m);
  return s==="done"?"✓":(s==="late"?"!":(s==="doing"?"…":"○"));
}
function upcomingMilestones(){
  return state.milestones
    .filter(m=>m.status!=="已完成" && m.plan_date)
    .map(m=>({m, pd:parseDate(m.plan_date)}))
    .sort((a,b)=>a.pd-b.pd);
}

/* ---- WBS 排期助手 ---- */
const TASK_STATUS = ["未开始","进行中","已完成","已取消"];
const PHASE_STATUS = ["未开始","进行中","已完成"];
function projPhases(pid){ return state.phases.filter(p=>p.project_id===pid); }
function projTasks(pid){ return state.tasks.filter(t=>t.project_id===pid); }
function phaseTasks(phid){ return state.tasks.filter(t=>t.phase_id===phid).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)||a.id-b.id); }
function taskState(t){
  if(t.status==="已完成"||t.status==="已取消") return "done";
  const pd=parseDate(t.plan_end), now=new Date(); now.setHours(0,0,0,0);
  if(pd && pd<now) return "late";
  if(t.status==="进行中") return "doing";
  const near = pd && (pd-now)/86400000<=3;
  return near? "near" : "todo";
}
function pillTaskStatus(s){
  const map={"未开始":"gray","进行中":"blue","已完成":"green","已取消":"red"};
  return `<span class="pill ${map[s]||"gray"}">${esc(s)}</span>`;
}
function pillPhaseStatus(s){
  const map={"未开始":"gray","进行中":"blue","已完成":"green"};
  return `<span class="pill ${map[s]||"gray"}">${esc(s)}</span>`;
}
function myOpenTasks(){
  return state.tasks.filter(t=>t.owner_id===(currentUser&&currentUser.id) && t.status!=="已完成" && t.status!=="已取消");
}
function myLateTasks(){ return myOpenTasks().filter(t=>taskState(t)==="late"); }

/* ================= 渲染 ================= */
const $view = document.getElementById("view");

function setTab(tab){
  state.ui.tab = tab;
  document.querySelectorAll("nav.side a,nav.bot a").forEach(a=>{
    if(a.dataset.tab) a.classList.toggle("active", a.dataset.tab===tab);
  });
  render();
  window.scrollTo(0,0);
}

function render(){
  const openCnt = state.issues.filter(i=>i.status!=="已解决").length;
  const nb=document.getElementById("navIssueNum");
  if(nb){ nb.style.display=openCnt?"":"none"; nb.textContent=openCnt; }
  const t = state.ui.tab;
  if(t==="overview") renderOverview();
  else if(t==="projects") renderProjects();
  else if(t==="users") renderUsers();
  else if(t==="gantt") renderGantt();
  else if(t==="schedule") renderSchedule();
  else if(t==="mytasks") renderMyTasks();
  else if(t==="contracts") renderContracts();
  else if(t==="reports") renderReports();
  else renderIssues();
}

/* ---- 用户管理（仅管理员） ---- */
let usersCache=[];
async function loadUsers(){
  usersCache = await api("/api/users");
}
async function renderUsers(){
  if(!currentUser || currentUser.role!=="admin"){ $view.innerHTML='<div class="card"><div class="empty">需要管理员权限</div></div>'; return; }
  try{ await loadUsers(); await loadLlmSettings(); }catch(e){ toast(e.message); return; }
  let h = `<div class="card"><h2>用户管理
    <span class="h-act"><button class="sm" onclick="openUserModal()">＋ 新增用户</button></span></h2>
    <div class="muted" style="margin-bottom:10px">普通用户只能看到「自己登记」或「负责人填了自己用户名/姓名」的项目；管理员可见全部。</div>`;
  usersCache.forEach(u=>{
    const self = currentUser && u.id===currentUser.id;
    h += `<div class="mod-row">
      <div class="mi"><b>${esc(u.username)}${self?"（我）":""} ${u.role==="admin"?'<span class="pill ink">管理员</span>':'<span class="pill gray">普通用户</span>'}</b>
        <span>${esc(u.display_name||"未填姓名")} · 创建于 ${esc((u.created_at||"").slice(0,10))}</span></div>
      <div style="display:flex;gap:6px;margin-left:auto">
        <button class="sm ghost" onclick="openUserModal(${u.id})">编辑</button>
        ${self?"":`<button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delUser(${u.id},'${esc(u.username)}')">删</button>`}
      </div>
    </div>`;
  });
  h += `</div>`;
  h += llmCardHtml();
  $view.innerHTML = h;
}

/* ---- 大模型设置（仅管理员，密钥加密存储） ---- */
let llmSettings = null;
async function loadLlmSettings(){ llmSettings = await api("/api/settings/llm"); }
function llmCardHtml(){
  const s = llmSettings || {};
  const fromEnv = s.source === "env";
  return `<div class="card">
    <h2>大模型设置（用于周报润色）
      <span class="h-act">${s.configured
        ? `<span class="pill green">已就绪 · ${esc(s.model||"deepseek-chat")}${fromEnv?" · 来自 .env":""}</span>`
        : `<span class="pill amber">未配置 · 周报暂用本地模板</span>`}</span></h2>
    <div class="muted" style="margin-bottom:6px">
      密钥在服务端用 AES-256-GCM 加密后存入数据库，页面不显示密钥（连掩码也不显示），只显示当前使用的模型名；明文只在服务端调用模型时使用。
      ${fromEnv?"当前使用的是 .env 里的环境变量密钥，建议改为在此处录入（可随时更换、清除）。":""}
    </div>
    ${s.corrupt?`<div class="rep-note">已存的密钥无法解密（可能更换过 SESSION_SECRET / SETTINGS_SECRET），请重新录入。</div>`:""}
    <div class="grid2">
      <div><label class="fld">API Key ${s.configured?"（留空表示不修改）":""}</label>
        <input id="llmKey" type="password" autocomplete="off" placeholder="${s.configured?"已保存，如需更换请输入新密钥":"粘贴密钥，例如 sk-..."}"></div>
      <div><label class="fld">模型名</label>
        <input id="llmModel" value="${esc(s.model||"deepseek-chat")}" placeholder="deepseek-chat"></div>
    </div>
    <label class="fld">接口地址（OpenAI 兼容）</label>
    <input id="llmBase" value="${esc(s.base_url||"https://api.deepseek.com/v1")}" placeholder="https://api.deepseek.com/v1">
    <div class="row" style="margin-top:12px;align-items:center">
      <button class="sm" onclick="saveLlm()">保存设置</button>
      <button class="sm ghost" onclick="testLlm()" id="llmTestBtn" ${s.configured?"":"disabled"}>测试连接</button>
      ${s.configured?`<button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="clearLlm()">清除密钥</button>`:""}
      <span class="muted" id="llmMsg"></span>
    </div>
  </div>`;
}
async function saveLlm(){
  const key = document.getElementById("llmKey").value.trim();
  const base = document.getElementById("llmBase").value.trim();
  const model = document.getElementById("llmModel").value.trim();
  try{
    llmSettings = await api("/api/settings/llm", { method:"PUT", body: JSON.stringify({ api_key:key, base_url:base, model }) });
    toast(key ? "已加密保存密钥" : "设置已保存");
    await renderUsers();
  }catch(e){ toast(e.message); }
}
async function testLlm(){
  const btn = document.getElementById("llmTestBtn");
  const msg = document.getElementById("llmMsg");
  if(btn){ btn.disabled=true; btn.textContent="测试中…"; }
  if(msg) msg.textContent = "正在请求模型…";
  try{
    const r = await api("/api/settings/llm/test", { method:"POST" });
    if(msg) msg.textContent = `连接正常 · ${r.model} · ${r.ms}ms`;
    toast("连接正常，模型可用");
  }catch(e){
    if(msg) msg.textContent = e.message;
    toast(e.message);
  }finally{
    if(btn){ btn.disabled=false; btn.textContent="测试连接"; }
  }
}
async function clearLlm(){
  if(!confirm("清除已保存的大模型密钥？清除后周报将使用本地模板（.env 里的密钥不受影响）。")) return;
  try{
    llmSettings = await api("/api/settings/llm", { method:"DELETE" });
    toast("密钥已清除");
    await renderUsers();
  }catch(e){ toast(e.message); }
}
function openUserModal(id){
  const u = id? usersCache.find(x=>x.id===id): null;
  openModal(`<h3>${u?"编辑用户":"新增用户"}</h3>
    <div class="grid2">
      <div><label class="fld">登录账号 *</label><input id="u_username" value="${esc(u?u.username:"")}" ${u?"disabled":""} placeholder="字母/数字/下划线"></div>
      <div><label class="fld">姓名（用于项目负责人匹配）</label><input id="u_display" value="${esc(u?u.display_name:"")}" placeholder="如：张三"></div>
    </div>
    <label class="fld">${u?"重置密码（留空则不修改）":"初始密码 *"}</label><input id="u_pass" type="password" placeholder="${u?"留空保持原密码":"至少 4 位"}">
    <label class="fld">角色</label>
    <select id="u_role">
      <option value="user" ${(u?u.role:"user")==="user"?"selected":""}>普通用户</option>
      <option value="admin" ${(u&&u.role==="admin")?"selected":""}>管理员</option>
    </select>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveUser(${id||"null"})">保存</button>
    </div>`);
}
async function saveUser(id){
  const body={
    display_name:document.getElementById("u_display").value.trim(),
    role:document.getElementById("u_role").value };
  try{
    if(id){
      const pw=document.getElementById("u_pass").value;
      if(pw) body.password=pw;
      await api("/api/users/"+id,{method:"PUT",body:JSON.stringify(body)});
    }else{
      body.username=document.getElementById("u_username").value.trim();
      body.password=document.getElementById("u_pass").value;
      await api("/api/users",{method:"POST",body:JSON.stringify(body)});
    }
    closeModal(); await renderUsers(); toast("已保存");
  }catch(e){ toast(e.message); }
}
async function delUser(id, name){
  if(!confirm(`确定删除用户「${name}」？\n其创建的项目会保留，转为仅管理员可见。`)) return;
  try{ await api("/api/users/"+id,{method:"DELETE"}); await renderUsers(); toast("已删除"); }
  catch(e){ toast(e.message); }
}

/* ---- 总览 ---- */
function renderOverview(){
  const openIssues = state.issues.filter(i=>i.status!=="已解决");
  const upcoming = upcomingMilestones().slice(0,6);
  const doingMods = state.modules.filter(m=>m.status!=="未开始"&&m.status!=="已上线").length;
  const myOpen = myOpenTasks(), myLate = myOpenTasks().filter(t=>taskState(t)==="late");
  const soonTasks = myOpen.filter(t=>{
    const pd=parseDate(t.plan_end); if(!pd) return false;
    const diff=(pd-new Date(new Date().setHours(0,0,0,0)))/86400000;
    return diff>=0 && diff<=7;
  }).sort((a,b)=>a.plan_end<b.plan_end?-1:1);
  let h = `
  <div class="grid4" style="margin-bottom:16px">
    <div class="stat"><div class="n">${state.projects.length}</div><div class="t">项目总数</div></div>
    <div class="stat"><div class="n">${state.modules.length}</div><div class="t">上线模块</div></div>
    <div class="stat amber"><div class="n">${doingMods}</div><div class="t">进行中模块</div></div>
    <div class="stat red"><div class="n">${openIssues.length}</div><div class="t">未解决问题/需求</div></div>
  </div>
  <div class="grid4" style="margin-bottom:16px">
    <div class="stat"><div class="n">${state.tasks.length}</div><div class="t">WBS 任务</div></div>
    <div class="stat blue"><div class="n">${myOpen.length}</div><div class="t">我的待办任务</div></div>
    <div class="stat red"><div class="n">${myLate.length}</div><div class="t">我已逾期</div></div>
    <div class="stat amber"><div class="n">${soonTasks.length}</div><div class="t">我 7 天内到期</div></div>
  </div>`;

  h += `<div class="card"><h2>我的项目
    <span class="h-act"><button class="sm" onclick="openProjectModal()">＋ 新建项目</button></span></h2>`;
  if(!state.projects.length){
    h += `<div class="empty">还没有项目，点击右上角「新建项目」开始。<br><span class="muted">创建后会自动生成 部署/测试/培训/上线/验收 五个里程碑节点。</span></div>`;
  }
  state.projects.forEach(p=>{
    const ms=projMilestones(p.id), mods=projModules(p.id);
    const done=ms.filter(m=>m.status==="已完成").length;
    const pp=projProgress(p.id);
    const online=mods.filter(m=>m.status==="已上线").length;
    h += `<div class="list-item">
      <div class="top">
        <b>${esc(p.name)}</b>
        ${pillProj(p.status)}
        <span style="margin-left:auto;display:flex;gap:8px">
          <button class="sm soft" onclick="enterProject(${p.id})">进入</button>
          <button class="sm ghost" onclick="openProjectModal(${p.id})">编辑</button>
        </span>
      </div>
      <div class="progress"><span style="width:${pp}%"></span></div>
      <div class="meta">${p.owner?"负责人 "+esc(p.owner)+" · ":""}整体进度 ${pp}% · 模块已上线 ${online}/${mods.length} · 里程碑 ${done}/${ms.length} · 未解决问题 ${projOpenIssues(p.id)}</div>
    </div>`;
  });
  h += `</div>`;

  h += `<div class="card"><h2>即将到来的里程碑</h2>`;
  if(!upcoming.length) h += `<div class="empty">暂无未完成的里程碑</div>`;
  upcoming.forEach(({m,pd})=>{
    const p=getProj(m.project_id);
    const late = msState(m)==="late";
    const days = Math.round((pd - new Date(new Date().setHours(0,0,0,0)))/86400000);
    const dayTxt = days===0?"今天":(days>0?`${days} 天后`:`逾期 ${-days} 天`);
    h += `<div class="list-item"><div class="top">
      <b>${esc(m.name)}</b>
      ${late?'<span class="pill red">已逾期</span>':(days<=3?'<span class="pill amber">临近</span>':'')}
      <span class="muted" style="margin-left:auto">计划 ${esc(m.plan_date)} · ${dayTxt} · ${esc(p?p.name:"")}</span>
    </div></div>`;
  });
  h += `</div>`;

  if(myOpen.length){
    h += `<div class="card"><h2>我的任务${myLate.length?` <span class="pill red">${myLate.length} 个逾期</span>`:""}
      <span class="h-act"><button class="sm ghost" onclick="setTab('mytasks')">全部待办</button></span></h2>`;
    const show = myLate.concat(soonTasks).slice(0,6);
    if(!show.length) h += `<div class="empty">近期没有到期任务</div>`;
    show.forEach(t=>{
      const pd=parseDate(t.plan_end);
      const days=Math.round((pd-new Date(new Date().setHours(0,0,0,0)))/86400000);
      const dayTxt = taskState(t)==="late"? `逾期 ${-days} 天` : (days===0?"今天到期":`${days} 天后到期`);
      const proj = getProj(t.project_id);
      h += `<div class="list-item"><div class="top">
        <b>${esc(t.name)}</b>${taskState(t)==="late"?' <span class="pill red">逾期</span>':(days<=3?' <span class="pill amber">临近</span>':"")}
        <span class="pill cyan">${esc(proj?proj.name:"")}</span>
        <span class="muted" style="margin-left:auto">${esc(t.plan_end||"")} · ${dayTxt} · 负责人 ${esc(t.owner_name||"")}</span>
        <button class="sm ghost" onclick="setTab('mytasks')">更新</button>
      </div></div>`;
    });
    h += `</div>`;
  }

  h += `<div class="foot-tools">
    <button class="sm ghost" onclick="exportData()">导出 JSON 备份</button>
  </div>`;
  $view.innerHTML = h;
}

function pillProj(s){
  const map={"筹备中":"gray","进行中":"blue","已上线":"cyan","已验收":"green","暂停":"amber"};
  return `<span class="pill ${map[s]||"gray"}">${esc(s)}</span>`;
}
function pillMod(s){
  const map={"未开始":"gray","开发中":"blue","测试中":"amber","试运行":"cyan","已上线":"green","无法上线":"red"};
  return `<span class="pill ${map[s]||"gray"}">${esc(s)}</span>`;
}
function pillIssueType(t){
  const map={"问题":"amber","协调":"cyan","Bug":"red","需求":"blue"};
  return `<span class="pill ${map[t]||"gray"}">${esc(t)}</span>`;
}
function pillIssueStatus(s){
  const map={"待处理":"gray","处理中":"amber","已完成":"cyan","已解决":"green"};
  return `<span class="pill ${map[s]||"gray"}">${esc(s)}</span>`;
}
function pillPriority(p){
  const map={"高":"red","中":"amber","低":"gray"};
  return `<span class="pill ${map[p]||"gray"}">${esc(p)}</span>`;
}

function enterProject(pid){ state.ui.projId=pid; setTab("projects"); }

/* ---- 项目管理 ---- */
function renderProjects(){
  let h = `<div class="chips">
    <span class="chip ${state.ui.projId?"":"active"}" onclick="state.ui.projId=null;render()">全部项目</span>`;
  state.projects.forEach(p=>{
    h += `<span class="chip ${state.ui.projId===p.id?"active":""}" onclick="state.ui.projId=${p.id};render()">${esc(p.name)}</span>`;
  });
  h += `<span class="chip" style="color:var(--primary);border-color:var(--primary)" onclick="openProjectModal()">＋ 新建</span></div>`;

  if(state.ui.projId && getProj(state.ui.projId)){ h += projectDetail(state.ui.projId); }
  else {
    if(!state.projects.length){ h += `<div class="card"><div class="empty">暂无项目，点击上方「＋ 新建」创建。</div></div>`; }
    state.projects.forEach(p=>{ h += projectDetail(p.id); });
  }
  $view.innerHTML = h;
}

function projectDetail(pid){
  const p=getProj(pid); if(!p) return "";
  const ms=projMilestones(pid), mods=projModules(pid);
  let h = `<div class="card">
    <div class="proj-head">
      <div>
        <h2>${esc(p.name)} ${pillProj(p.status)}</h2>
        <div class="muted">${esc(p.code?"编号："+p.code:"")} ${esc(p.owner?"· 负责人："+p.owner:"")} · 创建于 ${esc((p.created_at||"").slice(0,10))}${p.note?" · "+esc(p.note):""}</div>
      </div>
      <span class="h-act" style="margin-left:auto;display:flex;gap:8px">
        <button class="sm soft" onclick="openModuleModal(${pid})">＋ 模块</button>
        <button class="sm soft" onclick="openIssueModal(${pid})">＋ 记录</button>
        <button class="sm soft" onclick="openContractModal(${pid})">＋ 合同</button>
        <button class="sm soft" onclick="state.ui.schedProj=${pid};setTab('schedule')">排期</button>
        <button class="sm ghost" onclick="openProjectModal(${pid})">编辑</button>
        <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delProject(${pid})">删除</button>
      </span>
    </div>
    <div class="progress" style="margin-top:10px"><span style="width:${projProgress(pid)}%"></span></div>
    <div class="muted" style="margin-top:4px">整体进度 ${projProgress(pid)}%</div>
  </div>`;

  h += `<div class="card"><h2>里程碑节点 <span class="muted" style="font-weight:400">（点击节点可编辑）</span></h2>`;
  if(!ms.length) h += `<div class="empty">暂无里程碑</div>`;
  else {
    h += `<div class="ms-track">`;
    ms.forEach(m=>{
      const st=msState(m);
      h += `<div class="ms-node ${st}" onclick="openMilestoneModal(${m.id})">
        <div class="ms-dot">${msIcon(m)}</div>
        <div class="ms-name">${esc(m.name)}</div>
        <div class="ms-date">${esc(m.plan_date||"未定")}${m.actual_date?"<br>完成："+esc(m.actual_date):""}</div>
      </div>`;
    });
    h += `</div>`;
  }
  h += `</div>`;

  h += `<div class="card"><h2>上线模块（${mods.length}）</h2>`;
  if(!mods.length) h += `<div class="empty">暂无模块，点击「＋ 模块」添加各上线功能模块</div>`;
  mods.forEach(m=>{
    const late = m.plan_date && m.status!=="已上线" && parseDate(m.plan_date) < new Date(new Date().setHours(0,0,0,0));
    const latest = modLatestUpdate(m.id);
    const ups = modUpdates(m.id);
    const mf = modFiles(m.id);
    h += `<div class="mod-row">
      <div class="mi"><b>${esc(m.name)} ${pillMod(m.status)}${late?' <span class="pill red">上线逾期</span>':""}</b>
        <span>${esc(m.owner?"负责人："+m.owner:"")}
          ${m.plan_start?" · 计划开始 "+esc(m.plan_start):""}${m.plan_date?" · 计划上线 "+esc(m.plan_date):""}${m.actual_date?" · 实际上线 "+esc(m.actual_date):""}</span></div>
      <div class="mp"><div class="progress" style="margin-top:0"><span style="width:${pct(m.progress)}%"></span></div>
        <div class="muted">进度 ${pct(m.progress)}%${m.progress_source==="wbs"?' <span class="pill blue" style="font-size:10px">WBS 自动</span>':""}${latest?" · 最近记录 "+esc(latest.update_date)+" 填 "+pct(latest.progress)+"%":""}</div></div>
      <div style="display:flex;gap:6px">
        <button class="sm" onclick="openUpdateModal(${m.id})">＋ 记进度</button>
        <button class="sm soft" onclick="openFilesModal(${m.id})">📎 附件${mf.length?" "+mf.length:""}</button>
        <button class="sm soft" onclick="openTemplateModal(${pid},${m.id})">WBS</button>
        <button class="sm ghost" onclick="openModuleModal(${pid},${m.id})">编辑</button>
        <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delItem('modules',${m.id})">删</button>
      </div>
      ${fileChips(m.id, m.status)}
      ${latest&&latest.note?`<div style="flex-basis:100%;font-size:13px;color:var(--ink);background:#eef2ff;border-radius:8px;padding:6px 10px"><b>${esc(latest.update_date)} 进度说明：</b>${esc(latest.note)}</div>`:""}
      ${ups.length>1?`<div style="flex-basis:100%;font-size:13px">
        <a href="javascript:void(0)" onclick="toggleUpdates(${m.id})" style="color:var(--brand)">${state.ui["_showUps"+m.id]?"收起":"展开"}全部进度记录（${ups.length} 条）</a></div>
        <div style="flex-basis:100%;${state.ui["_showUps"+m.id]?"":"display:none"}" id="upsBox${m.id}">
          ${ups.map(u=>`<div style="display:flex;gap:10px;align-items:center;border-top:1px dashed var(--line);padding:5px 2px">
            <span class="pill gray">${esc(u.update_date)}</span>
            <b style="min-width:44px">${pct(u.progress)}%</b>
            <span class="muted" style="flex:1">${esc(u.note||"")}</span>
            <button class="sm ghost" onclick="openUpdateModal(${m.id},${u.id})">改</button>
            <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delUpdate(${u.id},${m.id})">删</button>
          </div>`).join("")}
        </div>`:""}
      ${m.status==="无法上线"&&m.fail_reason?`<div style="flex-basis:100%;font-size:13px;color:var(--danger);background:var(--danger-soft);border-radius:8px;padding:6px 10px"><b>无法上线原因：</b>${esc(m.fail_reason)}</div>`:""}
      ${m.coord_note?`<div style="flex-basis:100%;font-size:13px;color:#b45309;background:var(--warn-soft);border-radius:8px;padding:6px 10px"><b>需协调配合：</b>${esc(m.coord_note)}</div>`:""}
      ${m.note?`<div style="flex-basis:100%;font-size:13px;color:var(--sub);background:#f9fafb;border:1px solid var(--line);border-radius:8px;padding:6px 10px"><b>备注：</b>${esc(m.note)}</div>`:""}
    </div>`;
  });
  h += `</div>`;

  const pis = projIssues(pid).slice().sort((a,b)=>(a.status==="已解决")-(b.status==="已解决"));
  h += `<div class="card"><h2>问题 · 协调 · Bug · 需求（${pis.filter(i=>i.status!=="已解决").length} 未解决）</h2>`;
  if(!pis.length) h += `<div class="empty">暂无记录</div>`;
  pis.forEach(i=>{ h += issueItem(i, true); });
  h += `</div>`;
  return h;
}

function issueItem(i, inProject){
  const p=issueProj(i.project_id);
  const mod=(state.modules.find(m=>m.id===i.module_id)||{}).name;
  const asgName = i.assignee_name || i.owner || "";
  const planLate = i.plan_date && i.status!=="已完成" && i.status!=="已解决" && parseDate(i.plan_date) < new Date(new Date().setHours(0,0,0,0));
  const open = i.status!=="已完成" && i.status!=="已解决";
  return `<div class="list-item">
    <div class="top">
      ${pillIssueType(i.type)}
      <b>${esc(i.title)}</b>
      ${pillPriority(i.priority)}
      ${pillIssueStatus(i.status)}
      ${planLate?'<span class="pill red">已逾期</span>':""}
      <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
        ${open&&i.assignee_id?`<button class="sm" onclick="openIssueFinishModal(${i.id})">提交已完成</button>`:""}
        ${i.status==="已完成"?`<button class="sm" onclick="issueTestPass(${i.id})">测试通过</button>
          <button class="sm ghost" style="color:#b45309;border-color:#b45309" onclick="issueReject(${i.id})">测试不通过</button>`:""}
        <select onchange="quickIssueStatus(${i.id},this.value)" style="width:auto;font-size:13px;padding:5px 8px">
          ${ISSUE_STATUS.map(s=>`<option value="${s}" ${i.status===s?"selected":""}>${s}</option>`).join("")}
        </select>
        <button class="sm ghost" onclick="openIssueModal(${i.project_id},${i.id})">编辑</button>
        ${getProj(i.project_id)?`<button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delItem('issues',${i.id})">删</button>`:""}
      </span>
    </div>
    ${i.detail?`<div class="desc">${esc(i.detail)}</div>`:""}
    ${i.status==="已完成"&&i.finish_note?`<div style="font-size:13px;color:var(--ok);background:var(--ok-soft,var(--primary-soft));border-radius:8px;padding:6px 10px"><b>完成状况：</b>${esc(i.finish_note)}</div>`:""}
    <div class="meta">${inProject?"":("项目："+esc(p?p.name:"未知")+" · ")}${esc(mod?"模块："+mod+" · ":"")}处理人：${esc(asgName||"未指派")} · 提交人：${esc(i.reporter_name||"—")} · 记录于 ${esc((i.created_at||"").slice(0,10))}
      ${i.plan_date?` · <span style="${planLate?"color:var(--danger);font-weight:700":""}">计划完成 ${esc(i.plan_date)}</span>`:""}
      ${i.actual_date?` · 实际完成 ${esc(i.actual_date)}`:""}
      ${i.actual_hours!=null&&i.actual_hours!==""?` · 实际工时 ${esc(i.actual_hours)}h`:""}
      ${i.resolved_at?" · 验收通过于 "+esc(i.resolved_at.slice(0,10)):""}</div>
  </div>`;
}

/* ---- 问题与需求（全部） ---- */
function renderIssues(){
  const f=state.ui;
  let list = state.issues.slice();
  if(f.issueProj!=="all") list=list.filter(i=>i.project_id===f.issueProj);
  if(f.issueType!=="all") list=list.filter(i=>i.type===f.issueType);
  if(f.issueStatus!=="all") list=list.filter(i=>i.status===f.issueStatus);
  if(f.issueMine==="assigned") list=list.filter(i=>currentUser&&i.assignee_id===currentUser.id);
  if(f.issueMine==="reported") list=list.filter(i=>currentUser&&i.reporter_id===currentUser.id);
  if(f.issueMine==="unresolved") list=list.filter(i=>i.status!=="已解决");
  list.sort((a,b)=>(a.status==="已解决")-(b.status==="已解决") || (a.priority==="高"?-1:1)-(b.priority==="高"?-1:1));

  let h = `<div class="card"><h2>问题 · 协调 · Bug · 需求
    <span class="h-act"><button class="sm" onclick="openIssueModal(state.ui.issueProj!=='all'?state.ui.issueProj:null)">＋ 新增记录</button></span></h2>
    <div class="row" style="margin-bottom:10px">
      <select style="width:auto" onchange="state.ui.issueProj=this.value==='all'?'all':+this.value;render()">
        <option value="all">全部项目</option>
        ${state.projects.map(p=>`<option value="${p.id}" ${f.issueProj===p.id?"selected":""}>${esc(p.name)}</option>`).join("")}
      </select>
      <select style="width:auto" onchange="state.ui.issueType=this.value;render()">
        <option value="all">全部类型</option>
        ${ISSUE_TYPES.map(t=>`<option ${f.issueType===t?"selected":""}>${t}</option>`).join("")}
      </select>
      <select style="width:auto" onchange="state.ui.issueStatus=this.value;render()">
        <option value="all">全部状态</option>
        ${ISSUE_STATUS.map(s=>`<option ${f.issueStatus===s?"selected":""}>${s}</option>`).join("")}
      </select>
      <select style="width:auto" onchange="state.ui.issueMine=this.value;render()">
        <option value="all" ${f.issueMine==="all"?"selected":""}>全部记录</option>
        <option value="assigned" ${f.issueMine==="assigned"?"selected":""}>指派给我的</option>
        <option value="reported" ${f.issueMine==="reported"?"selected":""}>我提交的</option>
        <option value="unresolved" ${f.issueMine==="unresolved"?"selected":""}>未完结</option>
      </select>
    </div>`;
  if(!list.length) h += `<div class="empty">没有符合条件的记录</div>`;
  list.forEach(i=>{ h += issueItem(i, false); });
  h += `</div>`;
  $view.innerHTML = h;
}

/* ---- 合同管理（上传/下载/删除，不做解析分析） ---- */
function fmtSize(n){
  if(n==null) return "";
  if(n<1024) return n+"B";
  if(n<1048576) return (n/1024).toFixed(1)+"KB";
  return (n/1048576).toFixed(1)+"MB";
}
function renderContracts(){
  const f=state.ui;
  let list = state.contracts.slice();
  if(f.ctProj!=="all") list=list.filter(c=>c.project_id===f.ctProj);
  const totalAmt = list.reduce((s,c)=>s+(+c.amount||0),0);

  let h = `<div class="card"><h2>合同管理
    <span class="h-act"><button class="sm" onclick="openContractModal(state.ui.ctProj!=='all'?state.ui.ctProj:null)">＋ 上传合同</button></span></h2>
    <div class="row" style="margin-bottom:10px">
      <select style="width:auto" onchange="state.ui.ctProj=this.value==='all'?'all':+this.value;render()">
        <option value="all">全部项目</option>
        ${state.projects.map(p=>`<option value="${p.id}" ${f.ctProj===p.id?"selected":""}>${esc(p.name)}</option>`).join("")}
      </select>
      <span class="muted" style="align-self:center">共 ${list.length} 份合同${totalAmt>0?" · 金额合计 ¥"+totalAmt.toLocaleString("zh-CN"):""}</span>
    </div>`;
  if(!list.length) h += `<div class="empty">暂无合同，点击右上角「上传合同」添加（支持 PDF / Word / Excel / 图片 / 压缩包，单个 ≤ 50MB）</div>`;
  list.forEach(c=>{
    const ext=(c.file_name||"").split(".").pop().toLowerCase();
    h += `<div class="mod-row">
      <div class="mi"><b>${esc(c.name)}</b>
        <span>${esc(c.code?"编号："+c.code+" · ":"")}所属项目：${esc(c.project_name||"—")}
          ${c.party?" · 对方："+esc(c.party):""}${c.sign_date?" · 签订 "+esc(c.sign_date):""}
          · 上传人 ${esc(c.uploader_name||"—")} · ${esc((c.created_at||"").slice(0,10))}</span></div>
      <div class="mp">
        ${c.amount!=null&&c.amount!==""?`<div class="muted">金额 ¥${(+c.amount).toLocaleString("zh-CN")}</div>`:""}
        <div class="muted">📎 ${esc(c.file_name)}（${esc(fmtSize(c.file_size))}）</div>
        ${c.note?`<div class="muted">备注：${esc(c.note)}</div>`:""}
      </div>
      <div style="display:flex;gap:6px">
        <button class="sm" onclick="window.open('/api/contracts/${c.id}/file')">下载</button>
        <button class="sm ghost" onclick="openContractModal(null,${c.id})">编辑</button>
        <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delContract(${c.id},'${esc(c.name)}')">删</button>
      </div>
    </div>`;
  });
  h += `</div>`;
  $view.innerHTML = h;
}

function openContractModal(pid, id){
  const c = id? state.contracts.find(x=>x.id===id): null;
  const curPid = c? c.project_id : (pid&&getProj(pid)? pid : (state.projects[0]?state.projects[0].id:null));
  if(!state.projects.length){ toast("请先创建项目，再上传合同"); return; }
  openModal(`<h3>${c?"编辑合同信息":"上传合同"}</h3>
    <label class="fld">所属项目 *</label>
    <select id="c_proj" ${c?"disabled":""}>${state.projects.map(p=>`<option value="${p.id}" ${curPid===p.id?"selected":""}>${esc(p.name)}</option>`).join("")}</select>
    <label class="fld">合同名称 *</label><input id="c_name" value="${esc(c?c.name:"")}" placeholder="如：XX系统软件采购合同">
    <div class="grid2">
      <div><label class="fld">合同编号</label><input id="c_code" value="${esc(c?c.code:"")}" placeholder="选填"></div>
      <div><label class="fld">合同金额（元）</label><input id="c_amt" type="number" min="0" step="0.01" value="${c&&c.amount!=null?c.amount:""}" placeholder="选填"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">对方单位</label><input id="c_party" value="${esc(c?c.party:"")}" placeholder="选填"></div>
      <div><label class="fld">签订日期</label><input id="c_sign" type="date" value="${esc(c?c.sign_date||"":"")}"></div>
    </div>
    <label class="fld">备注</label><textarea id="c_note" placeholder="选填">${esc(c?c.note||"":"")}</textarea>
    ${c?"":`<label class="fld">合同文件 *（PDF / Word / Excel / 图片 / 压缩包，≤ 50MB）</label>
    <input id="c_file" type="file" style="padding:8px">`}
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveContract(${id?"null":(pid||"null")},${id||"null"})">${c?"保存":"上传"}</button>
    </div>`);
}
async function saveContract(pid, id){
  const name=document.getElementById("c_name").value.trim();
  if(!name){ toast("请填写合同名称"); return; }
  const meta={
    name,
    code:document.getElementById("c_code").value.trim(),
    amount:document.getElementById("c_amt").value,
    party:document.getElementById("c_party").value.trim(),
    signDate:document.getElementById("c_sign").value,
    note:document.getElementById("c_note").value.trim() };
  try{
    if(id){
      await api("/api/contracts/"+id,{method:"PUT",body:JSON.stringify(meta)});
    }else{
      const fileInput=document.getElementById("c_file");
      if(!fileInput.files.length){ toast("请选择合同文件"); return; }
      const fd=new FormData();
      const projId=parseInt(document.getElementById("c_proj").value,10);
      fd.append("project_id", projId);
      Object.entries(meta).forEach(([k,v])=>fd.append(k,v));
      fd.append("file", fileInput.files[0]);
      const r=await fetch("/api/contracts",{method:"POST",body:fd});
      if(r.status===401){ currentUser=null; applyUser(); showLogin(); throw new Error("未登录或会话已过期"); }
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d.error||("上传失败("+r.status+")"));
    }
    closeModal(); await refresh(); markSaved(); toast(id?"已保存":"合同已上传");
  }catch(e){ toast(e.message); }
}
async function delContract(id, name){
  if(!confirm(`确定删除合同「${name}」？\n磁盘上的合同文件将一并删除，不可恢复。`)) return;
  try{ await api("/api/contracts/"+id,{method:"DELETE"}); await refresh(); markSaved(); toast("已删除"); }
  catch(e){ toast(e.message); }
}

/* ================= 模块附件（培训签到单 / 上线确认单 / 模块验收报告等） ================= */
function fileListHtml(mid){
  const list = modFiles(mid).slice().sort((a,b)=>
    (FILE_CATEGORIES.indexOf(a.category)-FILE_CATEGORIES.indexOf(b.category)) || (a.id-b.id));
  if(!list.length){
    return `<div class="empty" style="padding:12px">还没有附件。上线/验收前建议补齐：培训签到单、上线确认单、模块验收报告。</div>`;
  }
  return `<div class="file-list">${list.map(f=>`<div class="file-item">
    <span class="pill blue">${esc(f.category)}</span>
    <div class="fi-main"><b>${esc(f.file_name)}</b>
      <span>${esc(fmtSize(f.file_size))} · ${esc(f.uploader_name||"—")} · ${esc((f.created_at||"").slice(0,10))}${f.note?" · "+esc(f.note):""}</span></div>
    <button class="sm" onclick="window.open('/api/module-files/${f.id}/file')">下载</button>
    <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delModuleFile(${f.id})">删</button>
  </div>`).join("")}</div>`;
}

function openFilesModal(mid){
  const m = state.modules.find(x=>x.id===mid);
  if(!m) return;
  state.ui.fileMod = mid;
  const p = getProj(m.project_id);
  openModal(`<h3>📎 ${esc(m.name)} · 交付附件</h3>
    <div class="muted" style="margin:-8px 0 12px">项目：${esc(p?p.name:"—")}。附件用于留存培训签到单、上线确认单、模块验收报告等过程材料，删除模块/项目时一并清理。</div>
    ${fileListHtml(mid)}
    <div class="sec-title">上传附件</div>
    <div class="grid2">
      <div><label class="fld">附件类型 *</label>
        <select id="f_cat">${FILE_CATEGORIES.map(c=>`<option>${c}</option>`).join("")}</select></div>
      <div><label class="fld">补充说明</label>
        <input id="f_note" placeholder="选填，如：培训 18 人签到"></div>
    </div>
    <label class="fld">选择文件 *（可多选，单个 ≤ 50MB；支持 PDF / Word / Excel / PPT / 图片 / 压缩包）</label>
    <input id="f_files" type="file" multiple style="padding:8px">
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">关闭</button>
      <button id="f_upBtn" onclick="uploadFiles(${mid})">上传</button>
    </div>`, "wide");
}

async function uploadFiles(mid){
  const input = document.getElementById("f_files");
  if(!input || !input.files.length){ toast("请选择要上传的附件"); return; }
  if(input.files.length > 10){ toast("一次最多上传 10 个文件"); return; }
  const btn = document.getElementById("f_upBtn");
  if(btn){ btn.disabled = true; btn.textContent = "上传中…"; }
  try{
    const fd = new FormData();
    fd.append("module_id", mid);
    fd.append("category", document.getElementById("f_cat").value);
    fd.append("note", document.getElementById("f_note").value.trim());
    for(const f of input.files) fd.append("files", f);
    const r = await fetch("/api/module-files", { method:"POST", body:fd });
    if(r.status === 401){ currentUser=null; applyUser(); showLogin(); throw new Error("未登录或会话已过期"); }
    const d = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error || ("上传失败("+r.status+")"));
    await refresh(); markSaved();
    openFilesModal(mid);
    toast(`已上传 ${d.count} 个附件`);
  }catch(e){
    toast(e.message);
    if(btn){ btn.disabled = false; btn.textContent = "上传"; }
  }
}

async function delModuleFile(id){
  const f = state.moduleFiles.find(x=>x.id===id);
  if(!f) return;
  if(!confirm(`确定删除附件「${f.file_name}」？\n磁盘文件将一并删除，不可恢复。`)) return;
  const mid = state.ui.fileMod || f.module_id;
  try{
    await api("/api/module-files/"+id, { method:"DELETE" });
    await refresh(); markSaved(); toast("附件已删除");
    openFilesModal(mid);
  }catch(e){ toast(e.message); }
}

/* ================= 周报 ================= */
let reportCfg = { llm:false, model:"" };
let reportHistory = [];
let reportView = null;

function mondayStr(s){
  const d = parseDate(s) || new Date();
  const wd = d.getDay();
  d.setDate(d.getDate() + (wd===0 ? -6 : 1-wd));
  return fmt(d);
}
function addDaysStr(s,n){ const d=parseDate(s); if(!d) return s; d.setDate(d.getDate()+n); return fmt(d); }
function weekLabel(start){ return start+" ~ "+addDaysStr(start,6); }

async function renderReports(){
  if(!state.projects.length){
    $view.innerHTML = `<div class="card"><div class="empty">还没有项目，先到「项目管理」创建一个。</div></div>`;
    return;
  }
  if(!state.ui.reportProj || !getProj(state.ui.reportProj)) state.ui.reportProj = state.projects[0].id;
  if(!state.ui.reportWeek) state.ui.reportWeek = mondayStr(todayStr());
  try{
    const [cfg, hist] = await Promise.all([
      api("/api/reports/config"),
      api("/api/reports?project_id="+state.ui.reportProj)
    ]);
    reportCfg = cfg; reportHistory = hist;
  }catch(e){ toast(e.message); }
  paintReports();
}

function paintReports(){
  const pid = state.ui.reportProj, week = state.ui.reportWeek;
  const srcPill = reportCfg.llm
    ? `<span class="pill green">大模型已就绪 · ${esc(reportCfg.model)}</span>`
    : `<span class="pill amber">未配置大模型 · 暂用本地模板</span>`;
  let h = `<div class="report-wrap">
    <div>
      <div class="card">
        <h2>项目周报 <span class="h-act">${srcPill}</span></h2>
        <div class="row" style="align-items:flex-end">
          <div style="min-width:180px;flex:1">
            <label class="fld">项目</label>
            <select onchange="state.ui.reportProj=+this.value;reportView=null;renderReports()">
              ${state.projects.map(p=>`<option value="${p.id}" ${p.id===pid?"selected":""}>${esc(p.name)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="fld">周（周一 ~ 周日）</label>
            <div style="display:flex;gap:6px;align-items:center">
              <button class="sm ghost" onclick="shiftReportWeek(-7)">←</button>
              <input type="date" value="${week}" style="width:152px" onchange="setReportWeek(this.value)">
              <button class="sm ghost" onclick="shiftReportWeek(7)">→</button>
              <button class="sm soft" onclick="setReportWeek('${mondayStr(todayStr())}')">本周</button>
            </div>
          </div>
          <button id="rpGen" onclick="generateReport()" style="min-width:124px">生成周报</button>
        </div>
        <div class="muted" style="margin-top:8px">依据 ${weekLabel(week)} 的模块进度记录、问题/需求变动、里程碑与合同汇总；同一周重新生成会覆盖旧稿。
          ${reportCfg.llm?"":` 想让 AI 润色：${currentUser&&currentUser.role==="admin"?"去「用户管理 → 大模型设置」录入密钥。":"联系管理员在「用户管理 → 大模型设置」录入密钥。"}`}</div>
      </div>
      ${reportView ? reportCardHtml() : `<div class="card"><div class="empty">${weekLabel(week)} 还没有周报，点上方「生成周报」。<br><span class="muted">即使没配大模型也能生成 —— 会用本地模板把本周数据汇总成结构化周报。</span></div></div>`}
    </div>
    <div class="card report-side">
      <h2>历史周报</h2>
      ${reportHistory.length ? reportHistory.map(r=>`<div class="rep-hist ${reportView&&reportView.id===r.id?"on":""}" onclick="openReport(${r.id})">
        <b>${esc(r.week_start)} ~ ${esc(r.week_end)}</b>
        <span>${r.source==="llm"?"AI"+(r.model?" · "+esc(r.model):""):"本地模板"} · ${esc((r.updated_at||r.created_at||"").slice(0,16))}</span>
      </div>`).join("") : `<div class="muted">该项目还没有生成过周报。</div>`}
    </div>
  </div>`;
  $view.innerHTML = h;
}

function reportCardHtml(){
  const r = reportView;
  const proj = getProj(r.project_id) || {};
  return `<div class="card">
    <h2>${esc(proj.name||"")} 周报 · ${esc(r.week_start)} ~ ${esc(r.week_end)}
      <span class="h-act">
        <span class="pill ${r.source==="llm"?"green":"gray"}">${r.source==="llm"?"AI 生成"+(r.model?" · "+esc(r.model):""):"本地模板"}</span>
        <button class="sm ghost" onclick="copyReport()">复制全文</button>
        <button class="sm" onclick="downloadReportWord()">下载 Word</button>
        <button class="sm ghost" onclick="downloadReport()">下载 .md</button>
        <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delReport(${r.id})">删</button>
      </span></h2>
    ${r.warning?`<div class="rep-note">${esc(r.warning)}</div>`:""}
    <div class="md-body">${mdToHtml(r.content)}</div>
  </div>`;
}

function setReportWeek(v){ state.ui.reportWeek = mondayStr(v); reportView=null; paintReports(); }
function shiftReportWeek(n){ state.ui.reportWeek = addDaysStr(state.ui.reportWeek, n); reportView=null; paintReports(); }

async function generateReport(){
  const btn = document.getElementById("rpGen");
  if(btn){ btn.disabled=true; btn.textContent = reportCfg.llm ? "AI 生成中…" : "生成中…"; }
  try{
    const r = await api("/api/reports/generate", { method:"POST", body: JSON.stringify({
      project_id: state.ui.reportProj, week_start: state.ui.reportWeek }) });
    reportView = r; state.ui.reportWeek = r.week_start;
    toast(r.warning ? r.warning : "周报已生成");
    await renderReports(); markSaved();
  }catch(e){
    toast(e.message);
    if(btn){ btn.disabled=false; btn.textContent="生成周报"; }
  }
}

async function openReport(id){
  try{
    const r = await api("/api/reports/"+id);
    reportView = r;
    if(getProj(r.project_id)) state.ui.reportProj = r.project_id;
    state.ui.reportWeek = r.week_start;
    await renderReports();
  }catch(e){ toast(e.message); }
}

async function delReport(id){
  if(!confirm("确定删除这份周报？重新生成即可恢复。")) return;
  try{ await api("/api/reports/"+id,{method:"DELETE"}); reportView=null; await renderReports(); toast("已删除"); }
  catch(e){ toast(e.message); }
}

async function copyReport(){
  if(!reportView) return;
  const text = reportView.content;
  try{ await navigator.clipboard.writeText(text); toast("已复制周报全文"); }
  catch(e){
    const ta=document.createElement("textarea");
    ta.value=text; ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand("copy"); toast("已复制周报全文"); }
    catch(_){ toast("复制失败，请手动选中全文复制"); }
    document.body.removeChild(ta);
  }
}

function downloadReportWord(){
  if(!reportView) return;
  window.open("/api/reports/" + reportView.id + "/docx");
}

function downloadReport(){
  if(!reportView) return;
  const p = getProj(reportView.project_id) || {};
  const blob = new Blob([reportView.content], { type:"text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (p.name||"项目") + "-周报-" + reportView.week_start + ".md";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}

/* ---- 极简 Markdown 渲染（标题/列表/表格/加粗/行内代码/引用） ---- */
function mdInline(s){
  return esc(s)
    .replace(/`([^`]+)`/g,"<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdToHtml(md){
  const lines = String(md||"").replace(/\r/g,"").split("\n");
  let html="", i=0, list=null;
  const closeList = ()=>{ if(list){ html += list==="ul" ? "</ul>" : "</ol>"; list=null; } };
  while(i < lines.length){
    const ln = lines[i];
    if(!ln.trim()){ closeList(); i++; continue; }

    // 表格
    if(/^\s*\|/.test(ln) && i+1<lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i+1])){
      closeList();
      const parseRow = t => t.trim().replace(/^\|/,"").replace(/\|$/,"").split("|").map(c=>c.trim());
      const head = parseRow(ln); i += 2;
      const rows = [];
      while(i<lines.length && /^\s*\|/.test(lines[i])){ rows.push(parseRow(lines[i])); i++; }
      html += '<div class="md-table"><table><thead><tr>'
        + head.map(c=>"<th>"+mdInline(c)+"</th>").join("")
        + "</tr></thead><tbody>"
        + rows.map(r=>"<tr>"+r.map(c=>"<td>"+mdInline(c)+"</td>").join("")+"</tr>").join("")
        + "</tbody></table></div>";
      continue;
    }

    let m = /^(#{1,6})\s+(.*)$/.exec(ln);
    if(m){
      closeList();
      const lv = Math.min(6, m[1].length + 1);
      html += `<h${lv}>${mdInline(m[2])}</h${lv}>`; i++; continue;
    }
    if(/^\s*(---|\*\*\*|___)\s*$/.test(ln)){ closeList(); html += "<hr>"; i++; continue; }
    if(/^\s*[-*+]\s+/.test(ln)){
      if(list!=="ul"){ closeList(); html += "<ul>"; list="ul"; }
      html += "<li>"+mdInline(ln.replace(/^\s*[-*+]\s+/,""))+"</li>"; i++; continue;
    }
    if(/^\s*\d+[.)]\s+/.test(ln)){
      if(list!=="ol"){ closeList(); html += "<ol>"; list="ol"; }
      html += "<li>"+mdInline(ln.replace(/^\s*\d+[.)]\s+/,""))+"</li>"; i++; continue;
    }
    if(/^\s*>\s?/.test(ln)){
      closeList();
      html += "<blockquote>"+mdInline(ln.replace(/^\s*>\s?/,""))+"</blockquote>"; i++; continue;
    }
    closeList();
    const buf=[ln]; i++;
    while(i<lines.length && lines[i].trim() && !/^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|\||>|---)/.test(lines[i])){
      buf.push(lines[i]); i++;
    }
    html += "<p>"+buf.map(mdInline).join("<br>")+"</p>";
  }
  closeList();
  return html;
}

/* ================= 排期计划（WBS） ================= */
function renderSchedule(){
  if(!state.projects.length){
    $view.innerHTML = `<div class="card"><div class="empty">还没有项目，先到「项目管理」创建一个。</div></div>`;
    return;
  }
  let pid = state.ui.schedProj;
  if(!pid || !getProj(pid)) pid = state.projects[0].id;
  const p = getProj(pid);
  const phases = projPhases(pid);
  const tasks = projTasks(pid);
  const orphan = tasks.filter(t=>!t.phase_id);
  const today = todayStr();
  const lateCnt = tasks.filter(t=>taskState(t)==="late").length;
  const openCnt = tasks.filter(t=>t.status!=="已完成"&&t.status!=="已取消").length;
  const doneCnt = tasks.filter(t=>t.status==="已完成").length;

  const opts = state.projects.map(x=>`<option value="${x.id}" ${x.id===pid?"selected":""}>${esc(x.name)}</option>`).join("");
  let h = `<div class="card">
    <h2>排期计划 · WBS
      <select onchange="state.ui.schedProj=parseInt(this.value,10);renderSchedule()" style="margin-left:10px;padding:4px 8px;border:1px solid var(--line);border-radius:8px">${opts}</select>
      <span class="h-act">
        <button class="sm soft" onclick="setTab('gantt')">甘特图</button>
        <button class="sm" onclick="openPhaseModal(${pid})">＋ 阶段</button>
      </span></h2>
    <div class="grid4" style="margin:10px 0 4px">
      <div class="stat"><div class="n">${tasks.length}</div><div class="t">任务总数</div></div>
      <div class="stat"><div class="n">${openCnt}</div><div class="t">未完成任务</div></div>
      <div class="stat green"><div class="n">${doneCnt}</div><div class="t">已完成</div></div>
      <div class="stat red"><div class="n">${lateCnt}</div><div class="t">已逾期</div></div>
    </div>
    <div class="muted">项目 → 阶段 → 任务三级拆解；任务可选关联上线模块；支持前置依赖（逾期黄标/红标）；模块进度可在编辑模块里切换为「按 WBS 加权自动计算」。</div>
  </div>`;

  if(!phases.length){
    h += `<div class="card"><div class="empty">该项目还没有排期阶段。点击右上角「＋ 阶段」创建，或到项目详情的模块行点「WBS」一键套用模板。</div></div>`;
  }
  phases.forEach(ph=>{
    const ts = phaseTasks(ph.id);
    const wsum = ts.reduce((s,t)=>s+(Number(t.estimate_hours)>0?Number(t.estimate_hours):1),0);
    const wprog = wsum? Math.round(ts.reduce((s,t)=>s+(Number(t.estimate_hours)>0?Number(t.estimate_hours):1)*pct(t.progress),0)/wsum) : 0;
    const phLate = ph.plan_end && ph.status!=="已完成" && ph.plan_end < today;
    h += `<div class="card">
      <div class="list-item" style="border:none;padding:0;margin-bottom:4px">
        <div class="top">
          <b>${esc(ph.name)} ${pillPhaseStatus(ph.status)}${phLate?' <span class="pill red">阶段逾期</span>':""}</b>
          <span class="muted" style="margin-left:8px">${ph.plan_start?"":"未排期"}${ph.plan_start?esc(ph.plan_start):""}${ph.plan_end?" ~ "+esc(ph.plan_end):""} · ${ts.length} 任务 · 加权进度 ${wprog}%</span>
          <span style="margin-left:auto;display:flex;gap:6px">
            <button class="sm soft" onclick="openTaskModal(${pid},null,${ph.id})">＋ 任务</button>
            <button class="sm ghost" onclick="openPhaseModal(${pid},${ph.id})">编辑</button>
            <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delPhase(${ph.id},'${esc(ph.name).replace(/'/g,"")}')">删</button>
          </span>
        </div>
      </div>`;
    if(!ts.length) h += `<div class="empty">该阶段暂无任务</div>`;
    ts.forEach((t,i)=>{
      const st = taskState(t);
      const latePill = st==="late"?' <span class="pill red">已逾期</span>':(st==="near"?' <span class="pill amber">临近</span>':"");
      const owner = t.owner_name? esc(t.owner_name) : "未指派";
      const mod = t.module_name? `<span class="pill cyan" title="关联上线模块">${esc(t.module_name)}</span> `:"";
      const pred = t.predecessor_name? `<span class="muted" title="前置任务">← ${esc(t.predecessor_name)}</span> `:"";
      h += `<div class="task-row">
        <div style="min-width:26px;text-align:right;color:#94a3b8;font-size:12px">${i+1}.</div>
        <div style="flex:1;min-width:0">
          <div><b>${esc(t.name)}</b> ${pillTaskStatus(t.status)}${latePill} ${mod}${pred}
            ${t.progress_source_check?"":""}<span class="muted">${t.plan_start?esc(t.plan_start):"?"}${t.plan_end?" ~ "+esc(t.plan_end):""}${Number(t.estimate_hours)>0?" · 预估 "+t.estimate_hours+"h":""}${Number(t.actual_hours)>0?" · 实际 "+t.actual_hours+"h":""}${t.actual_end?" · 完成 "+esc(t.actual_end):""}</span></div>
          <div class="muted" style="font-size:12px">负责人 ${owner}${t.note?" · "+esc(t.note):""}</div>
        </div>
        <div class="progress" style="width:130px;margin-top:0;flex-shrink:0"><span style="width:${pct(t.progress)}%"></span></div>
        <span class="muted" style="width:44px;text-align:right">${pct(t.progress)}%</span>
        <div style="display:flex;gap:6px;flex-shrink:0">
          ${t.status!=="已完成"&&t.status!=="已取消"?`<button class="sm ghost" onclick="quickTaskDone(${t.id})">完成</button>`:""}
          <button class="sm ghost" onclick="openTaskModal(${pid},${t.id})">编辑</button>
          <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delTask(${t.id},'${esc(t.name).replace(/'/g,"")}')">删</button>
        </div>
      </div>`;
    });
    h += `</div>`;
  });

  if(orphan.length){
    h += `<div class="card"><h2>未分组任务（${orphan.length}）</h2>`;
    orphan.forEach(t=>{
      h += `<div class="task-row">
        <div style="flex:1"><b>${esc(t.name)}</b> ${pillTaskStatus(t.status)} <span class="muted">${t.plan_start||"?"}${t.plan_end?" ~ "+t.plan_end:""} · 负责人 ${esc(t.owner_name||"未指派")}</span></div>
        <button class="sm ghost" onclick="openTaskModal(${pid},${t.id})">编辑</button>
      </div>`;
    });
    h += `</div>`;
  }
  $view.innerHTML = h;
}

/* ---- 我的任务 ---- */
let myTasksCache = null;
async function renderMyTasks(){
  let h = `<div class="card"><h2>我的任务
    <span class="h-act"><button class="sm ghost" onclick="renderMyTasks()">刷新</button></span></h2>
    <div class="muted">分配给我的未完结任务（跨项目），按计划完成时间排序。可在此直接更新状态与进度。</div></div>`;
  try{
    myTasksCache = await api("/api/tasks/my");
  }catch(e){ toast(e.message); return; }
  if(!myTasksCache.length){
    h += `<div class="card"><div class="empty">太棒了，没有待办任务 🎉</div></div>`;
  } else {
    const late = myTasksCache.filter(t=>t.is_late);
    if(late.length){
      h += `<div class="card"><h2><span style="color:var(--danger)">已逾期（${late.length}）</span></h2>`;
      late.forEach(t=>{ h += myTaskRow(t, true); });
      h += `</div>`;
    }
    const other = myTasksCache.filter(t=>!t.is_late);
    if(other.length){
      h += `<div class="card"><h2>待办（${other.length}）</h2>`;
      other.forEach(t=>{ h += myTaskRow(t, false); });
      h += `</div>`;
    }
  }
  $view.innerHTML = h;
}
function myTaskRow(t, late){
  const due = t.due_in_days;
  const dueTxt = due==null? "" : (due<0? `逾期 ${-due} 天` : (due===0? "今天到期" : `${due} 天后到期`));
  const proj = getProj(t.project_id);
  return `<div class="task-row">
    <div style="flex:1;min-width:0">
      <div><b>${esc(t.name)}</b> ${pillTaskStatus(t.status)}
        ${late?' <span class="pill red">已逾期</span>':(due!=null&&due<=3?' <span class="pill amber">临近</span>':"")}
        <span class="pill cyan">${esc(t.project_name||"")}</span>
        ${t.module_name?`<span class="pill gray">${esc(t.module_name)}</span>`:""}
        <span class="muted">${t.plan_start?esc(t.plan_start):"?"}${t.plan_end?" ~ "+esc(t.plan_end):""} · ${dueTxt}</span></div>
    </div>
    <div class="progress" style="width:120px;margin-top:0;flex-shrink:0"><span style="width:${pct(t.progress)}%"></span></div>
    <span class="muted" style="width:44px;text-align:right">${pct(t.progress)}%</span>
    <div style="display:flex;gap:6px;flex-shrink:0">
      <button class="sm" onclick="openMyTaskUpdate(${t.id})">更新</button>
      ${proj?`<button class="sm ghost" onclick="enterProject(${t.project_id})">项目</button>`:""}
    </div>
  </div>`;
}
async function openMyTaskUpdate(id){
  const t = (myTasksCache||[]).find(x=>x.id===id); if(!t) return;
  openDrawer(`<h3>更新任务 · ${esc(t.name)}</h3>
    <div class="muted" style="margin-bottom:8px">${esc(t.project_name||"")}${t.module_name?" · "+esc(t.module_name):""} · 计划 ${esc(t.plan_start||"?")}${t.plan_end?" ~ "+t.plan_end:""}</div>
    <div class="grid2">
      <div><label class="fld">状态</label>
        <select id="tk_status">${["未开始","进行中","已完成"].map(s=>`<option ${t.status===s?"selected":""}>${s}</option>`).join("")}</select></div>
      <div><label class="fld">进度（%）</label><input id="tk_prog" type="number" min="0" max="100" value="${pct(t.progress)}"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">实际开始</label><input id="tk_astart" type="date" value="${esc(t.actual_start||"")}"></div>
      <div><label class="fld">实际完成</label><input id="tk_aend" type="date" value="${esc(t.actual_end||"")}"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">实际工时（小时）</label><input id="tk_ah" type="number" min="0" step="0.5" value="${t.actual_hours||""}"></div>
    </div>
    <label class="fld">备注</label><textarea id="tk_note" style="min-height:200px">${esc(t.note||"")}</textarea>
    <div class="row" style="margin-top:16px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveMyTask(${id})">保存</button>
    </div>`);
}
async function saveMyTask(id){
  const body = {
    status: document.getElementById("tk_status").value,
    progress: pct(parseInt(document.getElementById("tk_prog").value,10)||0),
    actual_start: document.getElementById("tk_astart").value,
    actual_end: document.getElementById("tk_aend").value,
    actual_hours: document.getElementById("tk_ah").value,
    note: document.getElementById("tk_note").value.trim(),
  };
  try{
    await api("/api/tasks/"+id,{method:"PUT",body:JSON.stringify(body)});
    closeModal(); await refresh(); markSaved(); await renderMyTasks();
  }catch(e){ toast(e.message); }
}
async function quickTaskDone(id){
  try{
    await api("/api/tasks/"+id,{method:"PUT",body:JSON.stringify({status:"已完成"})});
    await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}

/* ---- 排期弹窗 ---- */
function openPhaseModal(pid, id){
  const ph = id? state.phases.find(x=>x.id===id): null;
  openModal(`<h3>${ph?"编辑阶段":"添加阶段"} · ${esc(getProj(pid).name)}</h3>
    <label class="fld">阶段名称 *</label><input id="ph_name" value="${esc(ph?ph.name:"")}" placeholder="如：需求与设计 / 开发实施 / 上线准备">
    <div class="grid2">
      <div><label class="fld">计划开始</label><input id="ph_ps" type="date" value="${esc(ph?ph.plan_start||"":"")}"></div>
      <div><label class="fld">计划结束</label><input id="ph_pe" type="date" value="${esc(ph?ph.plan_end||"":"")}"></div>
    </div>
    <label class="fld">状态</label>
    <select id="ph_status">${PHASE_STATUS.map(s=>`<option ${ph&&ph.status===s?"selected":""}>${s}</option>`).join("")}</select>
    <label class="fld">备注</label><textarea id="ph_note">${esc(ph?ph.note||"":"")}</textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="savePhase(${pid},${id||"null"})">保存</button>
    </div>`);
}
async function savePhase(pid, id){
  const name = document.getElementById("ph_name").value.trim();
  if(!name){ toast("请填写阶段名称"); return; }
  const body = { name,
    plan_start: document.getElementById("ph_ps").value,
    plan_end: document.getElementById("ph_pe").value,
    status: document.getElementById("ph_status").value,
    note: document.getElementById("ph_note").value.trim() };
  try{
    if(id) await api("/api/phases/"+id,{method:"PUT",body:JSON.stringify(body)});
    else await api("/api/phases",{method:"POST",body:JSON.stringify(Object.assign({project_id:pid},body))});
    closeModal(); await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}
async function delPhase(id, name){
  const ts = phaseTasks(id).length;
  if(!confirm(`删除阶段「${name}」？${ts?`其下 ${ts} 个任务将一并删除！`:""}`)) return;
  try{
    await api("/api/phases/"+id,{method:"DELETE"});
    await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}
async function openTaskModal(pid, id, presetPhase){
  const t = id? state.tasks.find(x=>x.id===id): null;
  const phases = projPhases(pid);
  if(!phases.length){ toast("请先创建阶段"); openPhaseModal(pid); return; }
  await loadAssignees();
  const mods = projModules(pid);
  const pre = presetPhase|| (t? t.phase_id : phases[0].id);
  openModal(`<h3>${t?"编辑任务":"添加任务"} · ${esc(getProj(pid).name)}</h3>
    <label class="fld">任务名称 *</label><input id="tk_name" value="${esc(t?t.name:"")}" placeholder="如：接口联调 / 数据迁移 / UAT 测试">
    <div class="grid2">
      <div><label class="fld">所属阶段 *</label>
        <select id="tk_phase">${phases.map(p=>`<option value="${p.id}" ${p.id===pre?"selected":""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div><label class="fld">关联上线模块（选填）</label>
        <select id="tk_mod"><option value="">不关联</option>${mods.map(m=>`<option value="${m.id}" ${t&&t.module_id===m.id?"selected":""}>${esc(m.name)}</option>`).join("")}</select></div>
    </div>
    <div class="grid2">
      <div><label class="fld">负责人</label>
        <select id="tk_owner"><option value="">未指派</option>${state.assignees.map(u=>`<option value="${u.id}" ${t&&t.owner_id===u.id?"selected":""}>${esc(u.display_name||u.username)}</option>`).join("")}</select></div>
      <div><label class="fld">前置任务（选填）</label>
        <select id="tk_pred"><option value="">无</option>${projTasks(pid).filter(x=>!t||x.id!==t.id).map(x=>`<option value="${x.id}" ${t&&t.predecessor_id===x.id?"selected":""}>${esc(x.name)}</option>`).join("")}</select></div>
    </div>
    <div class="grid2">
      <div><label class="fld">计划开始</label><input id="tk_ps" type="date" value="${esc(t?t.plan_start||"":"")}"></div>
      <div><label class="fld">计划结束</label><input id="tk_pe" type="date" value="${esc(t?t.plan_end||"":"")}"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">预估工时（小时）</label><input id="tk_eh" type="number" min="0" step="0.5" value="${t&&t.estimate_hours!=null?t.estimate_hours:""}"></div>
      <div><label class="fld">状态</label>
        <select id="tk_status">${TASK_STATUS.map(s=>`<option ${t&&t.status===s?"selected":""}>${s}</option>`).join("")}</select></div>
    </div>
    <label class="fld">进度（%）</label><input id="tk_prog" type="number" min="0" max="100" value="${t?pct(t.progress):0}">
    <label class="fld">备注</label><textarea id="tk_note">${esc(t?t.note||"":"")}</textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveTask(${pid},${id||"null"})">保存</button>
    </div>`);
}
async function saveTask(pid, id){
  const name = document.getElementById("tk_name").value.trim();
  if(!name){ toast("请填写任务名称"); return; }
  const body = { name,
    phase_id: parseInt(document.getElementById("tk_phase").value,10),
    module_id: document.getElementById("tk_mod").value||null,
    owner_id: document.getElementById("tk_owner").value||null,
    predecessor_id: document.getElementById("tk_pred").value||null,
    plan_start: document.getElementById("tk_ps").value,
    plan_end: document.getElementById("tk_pe").value,
    estimate_hours: document.getElementById("tk_eh").value,
    status: document.getElementById("tk_status").value,
    progress: pct(parseInt(document.getElementById("tk_prog").value,10)||0),
    note: document.getElementById("tk_note").value.trim() };
  try{
    if(id) await api("/api/tasks/"+id,{method:"PUT",body:JSON.stringify(body)});
    else await api("/api/tasks",{method:"POST",body:JSON.stringify(Object.assign({project_id:pid},body))});
    closeModal(); await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}
async function delTask(id, name){
  if(!confirm(`删除任务「${name}」？`)) return;
  try{
    await api("/api/tasks/"+id,{method:"DELETE"});
    await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}
async function openTemplateModal(pid, mid){
  const m = state.modules.find(x=>x.id===mid); if(!m) return;
  let templates = [];
  try{ templates = await api("/api/tasks/templates"); }catch(e){ toast(e.message); return; }
  const phases = projPhases(pid);
  openModal(`<h3>套用 WBS 模板 · ${esc(m.name)}</h3>
    <label class="fld">选择模板</label>
    <select id="tpl_key">${templates.map(t=>`<option value="${esc(t.key)}">${esc(t.name)}（${t.items.length} 项）</option>`).join("")}</select>
    <div class="muted" style="margin:6px 0 10px">任务将按模块上线日期<b>倒排</b>（预留缓冲），生成后可逐条微调。</div>
    <div class="grid2">
      <div><label class="fld">上线日期（用于倒排）</label><input id="tpl_launch" type="date" value="${esc(m.plan_date||"")}"></div>
      <div><label class="fld">预留缓冲（天）</label><input id="tpl_buf" type="number" min="0" max="60" value="2"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">放入阶段</label>
        <select id="tpl_phase"><option value="">自动新建「实施」阶段</option>${phases.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
      <div><label class="fld">新阶段名称（选填）</label><input id="tpl_pname" placeholder="默认：实施"></div>
    </div>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="applyTemplate(${pid},${mid})">生成任务</button>
    </div>`);
}
async function applyTemplate(pid, mid){
  const body = {
    module_id: mid,
    template_key: document.getElementById("tpl_key").value,
    launch_date: document.getElementById("tpl_launch").value,
    buffer_days: document.getElementById("tpl_buf").value,
    phase_id: document.getElementById("tpl_phase").value||null,
    phase_name: document.getElementById("tpl_pname").value.trim()||undefined,
  };
  if(!body.launch_date){ toast("请填写上线日期（模板按上线日倒排）"); return; }
  try{
    const r = await api("/api/tasks/apply-template",{method:"POST",body:JSON.stringify(body)});
    closeModal(); await refresh(); markSaved();
    toast(`已生成 ${r.created} 个任务`);
  }catch(e){ toast(e.message); }
}

/* ================= 弹窗 ================= */
const mask=document.getElementById("modalMask"), modal=document.getElementById("modal");
function openModal(html, cls){ modal.className = "modal" + (cls ? " " + cls : ""); mask.classList.remove("drawer"); modal.innerHTML=html; mask.classList.add("show"); }
/* 右侧抽屉：适合表单较长或需要展示上下文列表的场景 */
function openDrawer(html){ modal.className = "modal drawer"; mask.classList.add("drawer"); modal.innerHTML=html; mask.classList.add("show"); }
function closeModal(){ mask.classList.remove("show"); mask.classList.remove("drawer"); }
mask.addEventListener("click",e=>{ if(e.target===mask) closeModal(); });

/* ---- 项目 ---- */
function openProjectModal(id){
  const p = id? getProj(id): null;
  openModal(`<h3>${p?"编辑项目":"新建项目"}</h3>
    <label class="fld">项目名称 *</label><input id="f_name" value="${esc(p?p.name:"")}" placeholder="如：客户中台系统">
    <div class="grid2">
      <div><label class="fld">项目编号</label><input id="f_code" value="${esc(p?p.code:"")}" placeholder="选填"></div>
      <div><label class="fld">负责人</label><input id="f_owner" value="${esc(p?p.owner:(currentUser?(currentUser.displayName||currentUser.username):""))}" placeholder="选填，填用户名或姓名以便对方可见"></div>
    </div>
    <label class="fld">项目状态</label>
    <select id="f_status">${PROJ_STATUS.map(s=>`<option ${p&&p.status===s?"selected":""}>${s}</option>`).join("")}</select>
    <label class="fld">备注</label><textarea id="f_note" placeholder="选填">${esc(p?p.note:"")}</textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveProject(${id||"null"})">保存</button>
    </div>`);
  setTimeout(()=>{ const el=document.getElementById("f_name"); if(el) el.focus(); },50);
}
async function saveProject(id){
  const name=document.getElementById("f_name").value.trim();
  if(!name){ toast("请填写项目名称"); return; }
  const body={ name,
    code:document.getElementById("f_code").value.trim(),
    owner:document.getElementById("f_owner").value.trim(),
    status:document.getElementById("f_status").value,
    note:document.getElementById("f_note").value.trim() };
  try{
    if(id) await api("/api/projects/"+id,{method:"PUT",body:JSON.stringify(body)});
    else{
      const r=await api("/api/projects",{method:"POST",body:JSON.stringify(body)});
      state.ui.projId=r.id;
      toast("项目已创建，已生成 5 个里程碑节点");
    }
    closeModal(); await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}
async function delProject(id){
  const p=getProj(id); if(!p) return;
  if(!confirm(`确定删除项目「${p.name}」？\n其模块、里程碑、问题记录将一并删除，且不可恢复。`)) return;
  try{ await api("/api/projects/"+id,{method:"DELETE"}); await refresh(); markSaved(); toast("项目已删除"); }
  catch(e){ toast(e.message); }
}

/* ---- 模块 ---- */
function openModuleModal(pid, id){
  const m = id? state.modules.find(x=>x.id===id): null;
  openModal(`<h3>${m?"编辑模块":"添加上线模块"}</h3>
    <label class="fld">模块名称 *</label><input id="m_name" value="${esc(m?m.name:"")}" placeholder="如：审批中心">
    <div class="grid2">
      <div><label class="fld">负责人</label><input id="m_owner" value="${esc(m?m.owner:"")}" placeholder="选填"></div>
      <div><label class="fld">进度（%）${m&&m.progress_source==="wbs"?"由 WBS 自动计算，此处为当前值":"手动填写 0–100"}</label><input id="m_prog" type="number" min="0" max="100" value="${m?pct(m.progress):0}"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">进度来源</label>
        <select id="m_psrc">
          <option value="manual" ${!m||m.progress_source!=="wbs"?"selected":""}>手动填写</option>
          <option value="wbs" ${m&&m.progress_source==="wbs"?"selected":""}>按 WBS 任务加权自动计算</option>
        </select></div>
      <div></div>
    </div>
    <div class="grid2">
      <div><label class="fld">计划开始时间</label><input id="m_pstart" type="date" value="${esc(m?m.plan_start||"":"")}"></div>
      <div><label class="fld">计划上线时间</label><input id="m_plan" type="date" value="${esc(m?m.plan_date||"":"")}"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">实际上线时间</label><input id="m_actual" type="date" value="${esc(m?m.actual_date||"":"")}"></div>
      <div></div>
    </div>
    <label class="fld">上线情况</label>
    <select id="m_status" onchange="syncFailWrap()">${MOD_STATUS.map(s=>`<option ${m&&m.status===s?"selected":""}>${s}</option>`).join("")}</select>
    <div id="m_failWrap" style="display:none">
      <label class="fld" style="color:var(--danger)">无法上线原因 *</label>
      <textarea id="m_fail" placeholder="如：依赖接口未就绪、环境未开通、需求变更、阻塞 Bug 未解决等">${esc(m?m.fail_reason||"":"")}</textarea>
    </div>
    <label class="fld">需要协调配合的内容</label>
    <textarea id="m_coord" placeholder="如：需客户方提供数据/账号、需运维开通权限、需第三方配合联调等（选填）">${esc(m?m.coord_note||"":"")}</textarea>
    <label class="fld">备注</label><textarea id="m_note" placeholder="选填">${esc(m?m.note:"")}</textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveModule(${pid},${id||"null"})">保存</button>
    </div>`);
  syncFailWrap();
}
function syncFailWrap(){
  const sel=document.getElementById("m_status"); const w=document.getElementById("m_failWrap");
  if(sel&&w) w.style.display = sel.value==="无法上线" ? "block" : "none";
}
async function saveModule(pid, id){
  const name=document.getElementById("m_name").value.trim();
  if(!name){ toast("请填写模块名称"); return; }
  const status=document.getElementById("m_status").value;
  const failReason=document.getElementById("m_fail").value.trim();
  if(status==="无法上线" && !failReason){ toast("无法上线的模块请填写原因"); return; }
  const actual=document.getElementById("m_actual").value;
  const body={ name,
    owner:document.getElementById("m_owner").value.trim(),
    plan_start:document.getElementById("m_pstart").value,
    plan_date:document.getElementById("m_plan").value,
    actual_date: status==="已上线" ? (actual||todayStr()) : actual,
    status, fail_reason:failReason,
    coord_note:document.getElementById("m_coord").value.trim(),
    progress:pct(parseInt(document.getElementById("m_prog").value,10)||0),
    progress_source:document.getElementById("m_psrc").value,
    note:document.getElementById("m_note").value.trim() };
  try{
    if(id) await api("/api/modules/"+id,{method:"PUT",body:JSON.stringify(body)});
    else await api("/api/modules",{method:"POST",body:JSON.stringify(Object.assign({project_id:pid},body))});
    closeModal(); await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}

/* ---- 进度记录（按日期填写，模块进度=最新一条）——右侧抽屉 ---- */
function openUpdateModal(mid, uid){
  const m = state.modules.find(x=>x.id===mid); if(!m) return;
  const u = uid? state.updates.find(x=>x.id===uid): null;
  const latest = modLatestUpdate(mid);
  const all = modUpdates(mid);
  const recent = all.slice(0,5);
  openDrawer(`<h3>${u?"修改进度记录":"登记进度"} · ${esc(m.name)}</h3>
    ${latest&&!u?`<div class="muted" style="margin-bottom:8px">当前进度 ${pct(m.progress)}%（${esc(latest.update_date)} 登记）。新记录将覆盖为最新进度。</div>`:""}
    <div class="grid2">
      <div><label class="fld">进度日期 *</label><input id="u_date" type="date" value="${esc(u?u.update_date:todayStr())}"></div>
      <div><label class="fld">本周进度（%）0–100</label><input id="u_prog" type="number" min="0" max="100" value="${u?pct(u.progress):pct(m.progress)}"></div>
    </div>
    <label class="fld">进度说明</label>
    <textarea id="u_note" style="flex:1;min-height:260px" placeholder="如：本周完成审批流联调，剩余报表导出功能（选填）">${esc(u?u.note||"":"")}</textarea>
    ${!u&&recent.length?`<div class="sec-title">最近记录（共 ${all.length} 条）</div>
    ${recent.map(x=>`<div style="display:flex;gap:10px;align-items:center;border-top:1px dashed var(--line);padding:6px 2px;font-size:13px">
      <span class="pill gray">${esc(x.update_date)}</span>
      <b style="min-width:44px">${pct(x.progress)}%</b>
      <span class="muted" style="flex:1;word-break:break-all">${esc(x.note||"")}</span>
      <button class="sm ghost" onclick="openUpdateModal(${mid},${x.id})">改</button>
      <button class="sm ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delUpdate(${x.id},${mid})">删</button>
    </div>`).join("")}`:""}
    <div class="row" style="margin-top:16px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveUpdate(${mid},${uid||"null"})">保存</button>
    </div>`);
}
async function saveUpdate(mid, uid){
  const date=document.getElementById("u_date").value;
  if(!date){ toast("请选择进度日期"); return; }
  const body={ update_date:date,
    progress:pct(parseInt(document.getElementById("u_prog").value,10)||0),
    note:document.getElementById("u_note").value.trim() };
  try{
    if(uid) await api("/api/updates/"+uid,{method:"PUT",body:JSON.stringify(body)});
    else await api("/api/updates",{method:"POST",body:JSON.stringify(Object.assign({module_id:mid},body))});
    closeModal(); await refresh(); markSaved(); toast("已登记，模块进度已更新");
  }catch(e){ toast(e.message); }
}
async function delUpdate(uid, mid){
  if(!confirm("确定删除这条进度记录？\n模块进度将回退为剩余记录中最新的一条。")) return;
  try{ await api("/api/updates/"+uid,{method:"DELETE"}); await refresh(); markSaved(); toast("已删除"); }
  catch(e){ toast(e.message); }
}
function toggleUpdates(mid){
  state.ui["_showUps"+mid] = !state.ui["_showUps"+mid];
  const box=document.getElementById("upsBox"+mid);
  if(box) box.style.display = state.ui["_showUps"+mid]?"":"none";
}

/* ---- 里程碑 ---- */
function openMilestoneModal(id){
  const m = state.milestones.find(x=>x.id===id); if(!m) return;
  const st = msState(m);
  const hint = st==="late"? '<span class="pill red">已超过计划日期</span>':(st==="done"?'<span class="pill green">已完成</span>':"");
  openModal(`<h3>里程碑：${esc(m.name)} ${hint}</h3>
    <label class="fld">节点名称</label><input id="ms_name" value="${esc(m.name)}">
    <div class="grid2">
      <div><label class="fld">计划日期</label><input id="ms_plan" type="date" value="${esc(m.plan_date||"")}"></div>
      <div><label class="fld">实际完成日期</label><input id="ms_actual" type="date" value="${esc(m.actual_date||"")}"></div>
    </div>
    <label class="fld">状态</label>
    <select id="ms_status">${["未开始","进行中","已完成"].map(s=>`<option ${m.status===s?"selected":""}>${s}</option>`).join("")}</select>
    <label class="fld">备注</label><textarea id="ms_note" placeholder="选填，如：验收标准、参与人等">${esc(m.note||"")}</textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" style="color:var(--danger);border-color:var(--danger)" onclick="delItem('milestones',${m.id})">删除节点</button>
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveMilestone(${id})">保存</button>
    </div>`);
}
async function saveMilestone(id){
  const m=state.milestones.find(x=>x.id===id); if(!m) return;
  const status=document.getElementById("ms_status").value;
  const actual = status==="已完成" ? (document.getElementById("ms_actual").value||todayStr()) : "";
  const body={
    name:document.getElementById("ms_name").value.trim()||m.name,
    plan_date:document.getElementById("ms_plan").value,
    actual_date:actual,
    status,
    note:document.getElementById("ms_note").value.trim() };
  try{
    await api("/api/milestones/"+id,{method:"PUT",body:JSON.stringify(body)});
    closeModal(); await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}

/* ---- 记录 ---- */
async function openIssueModal(pid, id){
  const i = id? state.issues.find(x=>x.id===id): null;
  let curPid = i? i.project_id : (pid && issueProj(pid)? pid : (state.ui.projId&&getProj(state.ui.projId)? state.ui.projId : (state.projects[0]?state.projects[0].id:null)));
  const mods = curPid? projModules(curPid):[];
  try{ await loadAssignees(); }catch(e){ /* 拉取失败则只能手填负责人 */ }
  /* 项目下拉 = 可见项目 +（编辑不可见项目的记录时）该记录所属项目 */
  const projOpts = state.projects.concat(
    (i && !getProj(i.project_id) && issueProj(i.project_id)) ? [issueProj(i.project_id)] : []
  );
  const opts = state.assignees.map(u=>{
    const label=(u.display_name||u.username)+(u.role==="admin"?"（管理员）":"");
    return `<option value="${u.id}" ${i&&i.assignee_id===u.id?"selected":""}>${esc(label)}</option>`;
  }).join("");
  openModal(`<h3>${i?"编辑记录":"新增记录"}</h3>
    <div class="grid2">
      <div><label class="fld">所属项目 *</label>
        <select id="i_proj" onchange="issueProjChanged()">${projOpts.map(p=>`<option value="${p.id}" ${curPid===p.id?"selected":""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div><label class="fld">关联模块</label><select id="i_module"><option value="">不关联</option></select></div>
    </div>
    <div class="grid2">
      <div><label class="fld">类型</label><select id="i_type">${ISSUE_TYPES.map(t=>`<option ${i&&i.type===t?"selected":""}>${t}</option>`).join("")}</select></div>
      <div><label class="fld">优先级</label><select id="i_pri">${PRIORITY.map(p=>`<option ${(i?i.priority:"中")===p?"selected":""}>${p}</option>`).join("")}</select></div>
    </div>
    <label class="fld">标题 *</label><input id="i_title" value="${esc(i?i.title:"")}" placeholder="一句话描述">
    <label class="fld">详细说明</label><textarea id="i_detail" placeholder="现象、复现步骤、期望结果、协调对象等（选填）">${esc(i?i.detail:"")}</textarea>
    <div class="grid2">
      <div><label class="fld">指派给（提交后进入对方工作台）</label>
        <select id="i_asg"><option value="">不指派（仅手填跟进人）</option>${opts}</select></div>
      <div><label class="fld">计划完成时间</label><input id="i_plan" type="date" value="${esc(i?i.plan_date||"":"")}"></div>
    </div>
    <div class="grid2">
      <div><label class="fld">跟进人（文字备注，选填）</label><input id="i_owner" value="${esc(i?i.owner:"")}" placeholder="指派后自动显示处理人姓名"></div>
      <div><label class="fld">状态</label><select id="i_status">${ISSUE_STATUS.map(s=>`<option ${(i?i.status:"待处理")===s?"selected":""}>${s}</option>`).join("")}</select></div>
    </div>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="saveIssue(${id||"null"})">保存</button>
    </div>`);
  fillModuleSelect(curPid, i? i.module_id:null);
  setTimeout(()=>{ const el=document.getElementById("i_title"); if(el) el.focus(); },50);
}
function fillModuleSelect(pid, cur){
  const sel=document.getElementById("i_module"); if(!sel) return;
  const mods=pid? projModules(pid):[];
  sel.innerHTML='<option value="">不关联</option>'+mods.map(m=>`<option value="${m.id}" ${cur===m.id?"selected":""}>${esc(m.name)}</option>`).join("");
}
function issueProjChanged(){
  const pid=parseInt(document.getElementById("i_proj").value,10);
  fillModuleSelect(pid, null);
}
async function saveIssue(id){
  const title=document.getElementById("i_title").value.trim();
  if(!title){ toast("请填写标题"); return; }
  if(!state.projects.length && !issueProj(parseInt(document.getElementById("i_proj").value,10))){ toast("请先创建项目"); return; }
  const asgVal=document.getElementById("i_asg").value;
  const body={
    project_id:parseInt(document.getElementById("i_proj").value,10),
    module_id:document.getElementById("i_module").value||null,
    type:document.getElementById("i_type").value,
    priority:document.getElementById("i_pri").value,
    title,
    detail:document.getElementById("i_detail").value.trim(),
    assignee_id:asgVal?parseInt(asgVal,10):null,
    plan_date:document.getElementById("i_plan").value,
    owner:document.getElementById("i_owner").value.trim(),
    status:document.getElementById("i_status").value };
  try{
    if(id) await api("/api/issues/"+id,{method:"PUT",body:JSON.stringify(body)});
    else await api("/api/issues",{method:"POST",body:JSON.stringify(body)});
    closeModal(); await refresh(); markSaved();
  }catch(e){ toast(e.message); }
}

/* ---- 流转：处理人提交已完成 → 提交人测试 → 通过/退回 ---- */
function openIssueFinishModal(id){
  const i = state.issues.find(x=>x.id===id); if(!i) return;
  openModal(`<h3>提交已完成 · ${esc(i.title)}</h3>
    <div class="muted" style="margin-bottom:8px">提交后状态变为「已完成」，将流转给提交人（${esc(i.reporter_name||"提交人")}）进行测试验收。</div>
    <div class="grid2">
      <div><label class="fld">实际完成时间 *</label><input id="fin_date" type="date" value="${todayStr()}"></div>
      <div><label class="fld">实际工时（小时）</label><input id="fin_hours" type="number" min="0" step="0.5" placeholder="如 4.5"></div>
    </div>
    <label class="fld">完成状况说明 *</label>
    <textarea id="fin_note" placeholder="如何解决的、影响范围、自测情况、注意事项等"></textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="submitFinish(${id})">提交已完成</button>
    </div>`);
}
async function submitFinish(id){
  const note=document.getElementById("fin_note").value.trim();
  if(!note){ toast("请填写完成状况说明"); return; }
  const it=state.issues.find(x=>x.id===id); if(!it) return;
  const hours=document.getElementById("fin_hours").value;
  const body=Object.assign({}, it, {
    status:"已完成",
    actual_date:document.getElementById("fin_date").value||todayStr(),
    actual_hours:hours===""?null:parseFloat(hours),
    finish_note:note });
  try{
    await api("/api/issues/"+id,{method:"PUT",body:JSON.stringify(body)});
    closeModal(); await refresh(); markSaved(); toast("已提交，等待提交人测试");
  }catch(e){ toast(e.message); }
}
async function issueTestPass(id){
  const it=state.issues.find(x=>x.id===id); if(!it) return;
  if(!confirm("确认测试通过，将记录「"+(it.title||"")+"」置为已解决？")) return;
  try{
    await api("/api/issues/"+id,{method:"PUT",body:JSON.stringify(Object.assign({},it,{status:"已解决"}))});
    await refresh(); markSaved(); toast("测试通过，已解决");
  }catch(e){ toast(e.message); }
}
async function issueReject(id){
  const it=state.issues.find(x=>x.id===id); if(!it) return;
  const reason=prompt("测试不通过的原因（将退回给处理人）：","");
  if(reason===null) return;
  const body=Object.assign({}, it, {
    status:"处理中",
    detail:(it.detail? it.detail+"\n" : "")+"【退回】"+todayStr()+" 测试不通过："+(reason||"未填写原因") });
  try{
    await api("/api/issues/"+id,{method:"PUT",body:JSON.stringify(body)});
    await refresh(); markSaved(); toast("已退回处理人");
  }catch(e){ toast(e.message); }
}
async function quickIssueStatus(id, s){
  const it=state.issues.find(x=>x.id===id); if(!it) return;
  /* 提交已完成需要填完成状况 → 走专门弹窗 */
  if(s==="已完成" && it.status!=="已完成"){ openIssueFinishModal(id); render(); return; }
  try{
    await api("/api/issues/"+id,{method:"PUT",body:JSON.stringify(Object.assign({},it,{status:s}))});
    await refresh(); markSaved();
  }catch(e){ toast(e.message); await refresh(); }
}
async function delItem(coll, id){
  if(!confirm("确定删除该条记录？不可恢复。")) return;
  try{ await api("/api/"+coll+"/"+id,{method:"DELETE"}); await refresh(); markSaved(); toast("已删除"); }
  catch(e){ toast(e.message); }
}

/* ================= 甘特图 ================= */
function renderGantt(){
  if(!state.projects.length){
    $view.innerHTML = `<div class="card"><div class="empty">还没有项目，先到「项目管理」创建一个。</div></div>`;
    return;
  }
  let pid = state.ui.ganttProj;
  if(!pid || !getProj(pid)) pid = state.projects[0].id;
  const p = getProj(pid);
  const mods = projModules(pid);
  const mss = projMilestones(pid);
  const today = new Date(); today.setHours(0,0,0,0);

  /* 时间范围：取所有模块起止/记录日期、任务起止与今日的并集，至少 14 天，前后留 2 天 */
  const phs = projPhases(pid).filter(ph=>phaseTasks(ph.id).length);
  const showTk = state.ui.ganttShowTasks !== false;
  let lo=null, hi=null;
  const consider=d=>{ if(d){ if(!lo||d<lo)lo=d; if(!hi||d>hi)hi=d; } };
  mods.forEach(m=>{
    consider(parseDate(m.plan_start)); consider(parseDate(m.plan_date)); consider(parseDate(m.actual_date));
    modUpdates(m.id).forEach(u=>consider(parseDate(u.update_date)));
  });
  if(showTk) projTasks(pid).forEach(t=>{ consider(parseDate(t.plan_start)); consider(parseDate(t.plan_end)); consider(parseDate(t.actual_end)); });
  consider(today);
  if(!lo){ lo=new Date(today); lo.setDate(lo.getDate()-7); }
  if(!hi){ hi=new Date(today); hi.setDate(hi.getDate()+7); }
  if(hi-lo < 13*86400000) hi = new Date(lo.getTime()+13*86400000);
  lo.setDate(lo.getDate()-2); hi.setDate(hi.getDate()+2);
  const days = Math.round((hi-lo)/86400000)+1;
  const dayW = Math.max(9, Math.min(30, Math.floor(2100/days)));
  const leftW = 175, rowH = 34, headH = 30;
  const msLane = mss.some(m=>m.plan_date) ? rowH : 0;
  const tkAll = showTk ? projTasks(pid) : [];
  const tkH = tkAll.length
    ? phs.reduce((s,ph)=> s + 22 + phaseTasks(ph.id).length*rowH, 0)
    : 0;
  const W = leftW + days*dayW + 16, H = headH + msLane + mods.length*rowH + tkH + 30;
  const X = d => leftW + Math.round((d-lo)/86400000)*dayW;

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;min-width:${W}px">`;
  /* 表头：日刻度 + 月份 */
  for(let i=0;i<days;i++){
    const d=new Date(lo.getTime()+i*86400000);
    const x=X(d), monthStart=d.getDate()===1;
    svg += `<line x1="${x}" y1="${headH-6}" x2="${x}" y2="${H-22}" stroke="${monthStart?"#cbd5e1":"#eef1f5"}" stroke-width="1"/>`;
    if(i===0||dayW>=14&&i%7===0||monthStart){
      svg += `<text x="${x+3}" y="${headH-10}" font-size="10" fill="${monthStart?"#334155":"#94a3b8"}">${d.getMonth()+1}/${d.getDate()}</text>`;
    }
  }
  svg += `<text x="${X(today)+3}" y="${H-8}" font-size="10" fill="#dc2626">今天</text>`;
  svg += `<line x1="${X(today)}" y1="${headH-6}" x2="${X(today)}" y2="${H-22}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  svg += `<line x1="${leftW}" y1="${headH-6}" x2="${leftW}" y2="${H-22}" stroke="#cbd5e1"/>`;

  /* 里程碑泳道 */
  let y = headH;
  if(msLane){
    const cy = y + rowH/2 - 4;
    svg += `<text x="${leftW-8}" y="${cy+4}" font-size="11" fill="#64748b" text-anchor="end">里程碑</text>`;
    mss.forEach(m=>{
      const pd=parseDate(m.plan_date); if(!pd) return;
      const done=m.status==="已完成";
      const cx=X(pd);
      svg += `<g ${m.id?`onclick="openMilestoneModal(${m.id})" style="cursor:pointer"`:""}>
        <title>${esc(m.name)} · 计划 ${esc(m.plan_date)}${m.actual_date?" · 完成 "+esc(m.actual_date):""}</title>
        <path d="M ${cx} ${cy-7} l 7 7 l -7 7 l -7 -7 z" fill="${done?"#16a34a":(msState(m)==="late"?"#dc2626":"#f59e0b")}" stroke="#fff" stroke-width="1.5"/>
        <text x="${cx}" y="${cy-11}" font-size="10" fill="#475569" text-anchor="middle">${esc(m.name)}</text>
      </g>`;
    });
    y += rowH;
  }

  /* 模块行 */
  mods.forEach((m,idx)=>{
    const ry = y + idx*rowH, cy = ry + rowH/2 - 4;
    svg += idx? `<line x1="0" y1="${ry}" x2="${W}" y2="${ry}" stroke="#f1f5f9"/>` : "";
    svg += `<text x="${leftW-8}" y="${cy+4}" font-size="12" fill="#0f172a" text-anchor="end">${esc(m.name.length>9?m.name.slice(0,9)+"…":m.name)}</text>
      <text x="${leftW-8}" y="${cy+15}" font-size="9" fill="#94a3b8" text-anchor="end">${pct(m.progress)}%</text>`;
    const ups=modUpdates(m.id).map(u=>parseDate(u.update_date)).filter(Boolean);
    let bs=[parseDate(m.plan_start), ups.length?ups.reduce((a,b)=>a<b?a:b):null].filter(Boolean).sort((a,b)=>a-b)[0]||null;
    let be=parseDate(m.plan_date)||parseDate(m.actual_date)||null;
    const done = m.status==="已上线";
    const late = !done && be && be<today;
    if(!bs && !be){
      svg += `<text x="${X(today)+6}" y="${cy+4}" font-size="10" fill="#cbd5e1">未排期</text>`;
      return;
    }
    if(!bs) bs=new Date(be);
    if(!be) be = bs<today ? new Date(today) : new Date(bs);
    if(be<bs) be=new Date(bs);
    const x1=X(bs), x2=Math.max(X(be), x1+8), w=x2-x1;
    const color = done? "#16a34a" : (late? "#dc2626" : (m.status==="无法上线"? "#94a3b8" : "#4f46e5"));
    const tip = `${m.name}\n状态：${m.status} · 进度 ${pct(m.progress)}%`
      + (m.plan_start?`\n计划开始：${m.plan_start}`:"")
      + (m.plan_date?`\n计划上线：${m.plan_date}${late?"（已逾期）":""}`:"")
      + (m.actual_date?`\n实际上线：${m.actual_date}`:"")
      + (ups.length?`\n进度记录 ${ups.length} 条`:"");
    svg += `<g onclick="openUpdateModal(${m.id})" style="cursor:pointer">
      <title>${esc(tip)}</title>
      <rect x="${x1}" y="${cy-8}" width="${w}" height="16" rx="8" fill="${done?"#dcfce7":(late?"#fee2e2":"#e0e7ff")}" stroke="${color}" stroke-width="1.2"/>
      <rect x="${x1}" y="${cy-8}" width="${Math.max(6,w*pct(m.progress)/100)}" height="16" rx="8" fill="${color}" opacity="0.85"/>
      ${done?`<path d="M ${x2+10} ${cy-6} l 5 5 l -5 5" stroke="#16a34a" stroke-width="2" fill="none"/>`:""}
    </g>`;
  });
  /* 任务行（按阶段分组）+ 依赖连线 */
  const barPos = {};   // taskId -> {x1,x2,cy}
  const arrowSegs = []; // {fx, fy, tx, ty}
  let ty = y + mods.length*rowH;
  if(showTk && phs.length){
    phs.forEach(ph=>{
      const ts = phaseTasks(ph.id);
      ty += 22;
      svg += `<text x="${leftW-8}" y="${ty-8}" font-size="10" fill="#94a3b8" text-anchor="end">▸ ${esc(ph.name)}</text>`;
      ts.forEach((t,idx)=>{
        const ry = ty + idx*rowH, cy = ry + rowH/2 - 4;
        svg += idx? `<line x1="0" y1="${ry}" x2="${W}" y2="${ry}" stroke="#f8fafc"/>` : "";
        const os = t.owner_name? esc(t.owner_name.length>5?t.owner_name.slice(0,5)+"…":t.owner_name) : "未指派";
        svg += `<text x="${leftW-8}" y="${cy+4}" font-size="11" fill="#334155" text-anchor="end">${esc(t.name.length>9?t.name.slice(0,9)+"…":t.name)}</text>
          <text x="${leftW-8}" y="${cy+14}" font-size="8.5" fill="#94a3b8" text-anchor="end">${os}</text>`;
        const bs=parseDate(t.plan_start), be=parseDate(t.plan_end);
        const done = t.status==="已完成"||t.status==="已取消";
        const st = taskState(t);
        if(!bs && !be){
          svg += `<text x="${X(today)+6}" y="${cy+3}" font-size="9" fill="#cbd5e1">未排期</text>`;
          return;
        }
        const s2 = bs||be, e2 = be||bs;
        const x1=X(s2), x2=Math.max(X(e2), x1+7);
        barPos[t.id]={x1,x2,cy};
        const color = done? "#16a34a" : (st==="late"? "#dc2626" : (t.status==="进行中"? "#0ea5e9" : "#6366f1"));
        const fill = done? "#dcfce7" : (st==="late"? "#fee2e2" : "#e0f2fe");
        const tip = `${t.name}\n状态：${t.status} · 进度 ${pct(t.progress)}%`
          + (t.plan_start?`\n计划：${t.plan_start} ~ ${t.plan_end||"?"}`:"")
          + (t.owner_name?`\n负责人：${t.owner_name}`:"")
          + (t.module_name?`\n模块：${t.module_name}`:"")
          + (t.predecessor_name?`\n前置：${t.predecessor_name}`:"");
        svg += `<g onclick="openTaskModal(${pid},${t.id})" style="cursor:pointer">
          <title>${esc(tip)}</title>
          <rect x="${x1}" y="${cy-6}" width="${x2-x1}" height="12" rx="6" fill="${fill}" stroke="${color}" stroke-width="1"/>
          <rect x="${x1}" y="${cy-6}" width="${Math.max(4,(x2-x1)*pct(t.progress)/100)}" height="12" rx="6" fill="${color}" opacity="0.8"/>
        </g>`;
      });
      ty += ts.length*rowH;
    });
    /* 依赖连线：前置条右端 → 后置条左端（肘形） */
    tkAll.forEach(t=>{
      const a=barPos[t.predecessor_id], b=barPos[t.id];
      if(a&&b){
        const fx=a.x2, fy=a.cy, tx=b.x1, ty2=b.cy;
        const midX=fx+Math.max(8,(tx-fx)/2);
        arrowSegs.push(`<path d="M ${fx} ${fy} H ${midX} V ${ty2} H ${tx-4}" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 2"/>
          <path d="M ${tx-4} ${ty2-3} l 4 3 l -4 3 z" fill="#94a3b8"/>`);
      }
    });
    arrowSegs.forEach(seg=>{ svg += seg; });
  }
  svg += `</svg>`;

  /* 项目切换器 + 汇总 */
  const opts = state.projects.map(x=>`<option value="${x.id}" ${x.id===pid?"selected":""}>${esc(x.name)}</option>`).join("");
  $view.innerHTML = `
  <div class="card">
    <h2>项目甘特图
      <select id="ganttProj" onchange="state.ui.ganttProj=parseInt(this.value,10);renderGantt()" style="margin-left:10px;padding:4px 8px;border:1px solid var(--line);border-radius:8px">${opts}</select>
      <span class="h-act"><button class="sm ghost" onclick="setTab('projects')">返回列表</button></span></h2>
    <div class="muted" style="margin-bottom:8px">
      整体进度 <b>${projProgress(pid)}%</b> · 模块 ${mods.length} 个（已上线 ${mods.filter(m=>m.status==="已上线").length}）·
      任务 ${showTk?tkAll.length+" 个（"+phs.length+" 阶段）":"已隐藏"}
      <label style="margin-left:10px;font-weight:400"><input type="checkbox" ${showTk?"checked":""} onchange="state.ui.ganttShowTasks=this.checked;renderGantt()"> 显示 WBS 任务</label>
      <span class="h-act"><button class="sm ghost" onclick="setTab('schedule')">排期计划</button><button class="sm ghost" onclick="setTab('projects')">返回列表</button></span>
    </div>
    <div style="overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff">${svg}</div>
    <div class="muted" style="margin-top:8px;font-size:12px">
      图例：<span style="color:#4f46e5">■ 模块</span>　<span style="color:#0ea5e9">■ 任务进行中</span>　<span style="color:#16a34a">■ 已完成</span>　<span style="color:#dc2626">■ 逾期</span>　虚线箭头=任务依赖
      ｜点击任务条可编辑；<span style="color:#dc2626">红色虚线为今天</span>
    </div>
  </div>`;
}

/* ================= 备份 ================= */
function exportData(){
  const blob=new Blob([JSON.stringify({projects:state.projects,modules:state.modules,milestones:state.milestones,issues:state.issues,exported:todayStr()},null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="上线工作台备份-"+todayStr()+".json";
  a.click(); URL.revokeObjectURL(a.href);
  toast("备份已导出");
}

/* ================= 登录 ================= */
let currentUser=null;
function applyUser(){
  const pill=document.getElementById("mePill"), name=document.getElementById("meName");
  const isAdmin = currentUser && currentUser.role==="admin";
  ["navUsers","navUsersBot"].forEach(id=>{
    const el=document.getElementById(id); if(el) el.style.display=isAdmin?"":"none";
  });
  if(pill&&name){
    pill.style.display=currentUser?"":"none";
    name.textContent=(currentUser?currentUser.displayName||currentUser.username:"")+(isAdmin?" · 管理员":"");
  }
}
function showLogin(){
  document.getElementById("loginMask").classList.add("show");
  document.getElementById("shell").style.display="none";
}
function hideLogin(){
  document.getElementById("loginMask").classList.remove("show");
  document.getElementById("shell").style.display="";
}
async function doLogin(){
  const errEl=document.getElementById("loginErr");
  errEl.textContent="";
  try{
    const d = await api("/api/login",{method:"POST",body:JSON.stringify({
      username:document.getElementById("loginUser").value.trim(),
      password:document.getElementById("loginPass").value })});
    currentUser = (d && d.user) || null;
    applyUser();
    document.getElementById("loginPass").value="";
    state.ui.tab="overview";
    document.querySelectorAll("nav.side a,nav.bot a").forEach(a=>{
      if(a.dataset.tab) a.classList.toggle("active", a.dataset.tab==="overview");
    });
    await refresh();
    toast("登录成功");
  }catch(e){ errEl.textContent=e.message==="未登录或会话已过期"?"用户名或密码错误":e.message; }
}
async function doLogout(){
  try{ await api("/api/logout",{method:"POST"}); }catch(e){}
  currentUser=null; applyUser();
  state.projects=[]; state.modules=[]; state.milestones=[]; state.issues=[]; state.contracts=[]; state.phases=[]; state.tasks=[]; state.moduleFiles=[];
  state.ui.tab="overview"; state.ui.projId=null;
  showLogin();
}
document.getElementById("loginPass").addEventListener("keydown",e=>{ if(e.key==="Enter") doLogin(); });

/* ================= 杂项 ================= */
let toastTimer=null;
function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove("show"),2200);
}
document.querySelectorAll("nav.side a,nav.bot a").forEach(a=>{
  a.addEventListener("click",()=>{ if(a.dataset.tab) setTab(a.dataset.tab); });
});

/* 启动：先探测会话，已登录则拉取数据 */
(async function init(){
  try{
    const me=await fetch("/api/me");
    if(me.ok){
      const d=await me.json();
      currentUser=d.user||null;
      applyUser();
      await refresh();
    }
    else showLogin();
  }catch(e){ showLogin(); }
})();
