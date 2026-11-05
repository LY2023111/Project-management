/* 前端渲染模拟：问题流转相关 UI */
const els = {};
function el(id) {
  if (!els[id]) els[id] = { id, value: "", innerHTML: "", textContent: "", style: {},
    classList: { add(){}, remove(){}, toggle(){} }, addEventListener(){}, dataset: {} };
  return els[id];
}
global.document = {
  getElementById: id => el(id),
  querySelectorAll: () => [],
  createElement: () => el("_t" + Math.random()),
  addEventListener() {},
};
global.window = { scrollTo() {} };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.confirm = () => false;
global.prompt = () => null;
global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
global.currentUser = null;

const fs = require("fs");
const html = fs.readFileSync(__dirname + "/public/app.js", "utf8");
const harness = `
  state.projects=[{id:1,name:"郏县妇幼",status:"进行中"}];
  state.issueProjects=[{id:2,name:"不可见项目"}];
  state.assignees=[{id:5,username:"zhang",display_name:"张三",role:"user"},{id:6,username:"admin",display_name:"管理员",role:"admin"}];
  state.modules=[{id:11,project_id:1,name:"审批中心"}];
  currentUser={id:5,username:"zhang",displayName:"张三",role:"user"};
  const i1={id:100,project_id:1,module_id:11,type:"Bug",title:"导出报错",priority:"高",status:"处理中",
    assignee_id:5,assignee_name:"张三",reporter_id:6,reporter_name:"管理员",plan_date:"2026-10-01",
    actual_date:null,actual_hours:null,finish_note:"",detail:"现象",created_at:"2026-11-01 10:00:00",resolved_at:null};
  const i2=Object.assign({},i1,{id:101,status:"已完成",actual_date:"2026-11-09",actual_hours:4.5,finish_note:"已修复",project_id:2,module_id:null,plan_date:null});
  const i3=Object.assign({},i1,{id:102,status:"待处理",plan_date:"2026-11-01",assignee_id:null,assignee_name:null,owner:"",reporter_id:5});
  state.issues=[i1,i2,i3];
  const r={};
  try{ const c=issueItem(i1,true); r.card1=c.includes("已逾期")&&c.includes("张三")&&c.includes("提交已完成"); }catch(e){ r.e1=e.message; }
  try{ const c=issueItem(i2,false); r.card2=c.includes("完成状况：</b>已修复")&&c.includes("4.5h")&&c.includes("不可见项目")&&c.includes("测试通过")&&c.includes("测试不通过"); }catch(e){ r.e2=e.message; }
  try{ r.card3=issueItem(i3,true).includes("未指派"); }catch(e){ r.e3=e.message; }
  try{ await openIssueModal(1); r.modal=el("modal").innerHTML.includes('id="i_asg"')&&el("modal").innerHTML.includes("张三")&&el("modal").innerHTML.includes('id="i_plan"'); }catch(e){ r.em=e.message; }
  try{ await openIssueFinishModal(101); r.fin=!!document.getElementById("fin_note")&&!!document.getElementById("fin_hours"); }catch(e){ r.ef=e.message; }
  try{ renderIssues(); r.page=$view.innerHTML.includes("指派给我的"); }catch(e){ r.ep=e.message; }
  return JSON.stringify(r);
`;
(new Function("document", "window", "localStorage", "confirm", "prompt", "fetch", "el",
  html + "\n return (async () => { " + harness + " })();")(global.document, global.window, global.localStorage,
  global.confirm, global.prompt, global.fetch, el)).then(results => {
  console.log(JSON.stringify(JSON.parse(results), null, 1));
  const r = JSON.parse(results);
  const ok = !Object.keys(r).some(k => k.startsWith("e")) && r.card1 && r.card2 && r.card3 && r.modal && r.fin && r.page;
  console.log(ok ? "渲染模拟全部通过" : "存在失败项");
  process.exit(ok ? 0 : 1);
});
