# 实施计划：排期与 WBS（对应 design-schedule-wbs.md）

> 执行纪律：每个任务完成后立即验证；纯函数一律先写失败测试（RED）再实现（GREEN）。
> 基线：`npm test` 应为 60/60 通过。

## 任务清单

### 任务 1：测试基线
- 验证：`npm test` → 60/60 绿。不绿先停，修环境。

### 任务 2（TDD）：wbs.js 纯函数——环检测
- 文件：`test/wbs.test.js`（新）、`server/wbs.js`（新）
- 先写失败测试：`detectCycle(tasks, taskId, predecessorId)` —— 直链、长链、成环返回 true、跨阶段成环、自身成环
- 实现：沿 predecessor 链向上走，visited 集合判重；predecessor 不存在/跨项目忽略

### 任务 3（TDD）：wbs.js——加权进度
- 测试：`calcModuleProgress(tasks)` —— 空数组→null；权重=estimate_hours（空算 1）；四舍五入取整；含已取消任务应排除
- 实现：Σ(weight×progress)/Σweight

### 任务 4（TDD）：wbs.js——模板倒排
- 测试：`expandTemplate(template, launchDate, bufferDays)` —— 从上线日-缓冲往回排；自然日连续（前任务 end = 后任务 start−1）；返回 [{name, days, plan_start, plan_end}]；工期 0.5d 按 1 天占位；上线日无效抛错
- 实现：内置 TEMPLATES 常量（标准上线 7 任务 / 轻量上线 4 任务，见设计文档 4.3）

### 任务 5：建表与加列
- 文件：`server/db.js`
- `phases`、`tasks` 两表（字段见设计文档 §3，含外键 CASCADE / SET NULL；tasks.predecessor_id 不设真实外键约束，应用层校验，避免环删除顺序问题——改为普通 int 可空列）
- `modules` 平滑加列 `progress_source varchar(10) NOT NULL DEFAULT 'manual'`（information_schema 检查，复用现有 addColumn 模式）
- 验证：启动服务建表成功；`npm test` 集成库自动迁移

### 任务 6：校验规则
- 文件：`server/validate.js`
- phaseRules：name 必填 ≤100；status ∈ 枚举；plan_start/plan_end 可空合法日期；sort_order int
- taskRules：name 必填 ≤200；status 枚举；progress 0-100；日期可空合法；estimate_hours/actual_hours 数字 ≥0；predecessor_id/module_id/phase_id/owner_id 正整数或空
- FIELD_ALIASES 补 camelCase → snake_case
- 验证：单测（validate.test.js 加用例）

### 任务 7：阶段路由
- 文件：`server/routes/phases.js`（新）、`server/app.js` 挂载 `/api/phases`
- GET /?project_id（可见性过滤）、POST、PUT /:id、DELETE /:id、PUT /:id/sort
- 权限：canEditProject（admin/负责人）；普通用户只读 → 403
- 验证：集成测试 CRUD + 403

### 任务 8：任务路由（核心）
- 文件：`server/routes/tasks.js`（新）、`server/app.js` 挂载 `/api/tasks`
- GET /?project_id / ?mine=1；POST；PUT /:id（合并语义，防 PUT 清空）；DELETE /:id
- 服务端规则：predecessor 同项目、detectCycle 拒绝（400 带可读信息）；status↔progress 反向联动、actual_end/actual_start 缺省今天；保存后若 module.progress_source='wbs' → 重算模块进度并同步项目进度
- 权限：admin/项目负责人全量；任务 owner 本人仅限 status/progress/actual_start/actual_end/actual_hours/note 字段（其他字段变化直接忽略或 403——设计选 403 拒绝）；无权 403
- GET /api/my-tasks：owner=me 的任务（跨项目，无视项目可见性），联表 project_name/module_name，附 is_late、due_in_days
- 验证：集成测试覆盖以上每条规则

### 任务 9：模块进度源切换 + 模板套用
- 文件：`server/routes/modules.js`（PUT 支持 progress_source，切换即重算）、`server/routes/tasks.js` 内加 `POST /api/wbs/apply-template`（body: module_id, template_key, launch_date, buffer_days, phase_id?）
- apply-template：默认建/复用「实施」阶段；expandTemplate 生成任务批量插入（module_id 挂上）；返回创建数量
- GET /api/wbs/templates：返回模板清单（前端展示用）
- 验证：集成测试（倒排日期正确、追加不删除现有任务、phase 缺省自动建）

### 任务 10：bootstrap 联表与逾期标记
- 文件：`server/app.js`
- /api/bootstrap 增加 phases、tasks（含 owner_name、module_name、predecessor_name、is_late 计算字段：plan_end<今天 且 status∈{未开始,进行中}）；可见性同项目 ∪ owner=me
- 概览统计由前端基于 bootstrap 数据计算
- 验证：集成测试 bootstrap 返回字段

### 任务 11：周报聚合增强
- 文件：`server/weekly.js`
- 数据聚合增加：late_tasks（逾期）、due_tasks（本周到期）、模块 WBS 完成度（module.task_stats）
- buildTemplate：风险区加「逾期任务」「本周到期任务」小节；模块表加「WBS」列；下周计划加到期任务
- buildMessages facts 增加 wbs 数据（AI 提示词要求汇总）
- 验证：weekly.test.js 加用例（late/due 计算）

### 任务 12：前端——页签与排期列表页
- 文件：`public/index.html`（加「排期计划」「我的任务」页签）、`public/app.js`（state.ui.scheduleProj / renderSchedule / 增删改弹窗 / 统计条 / 上下移 / 套模板弹窗）、`public/styles.css`
- 验证：node --check + 手动冒烟

### 任务 13：前端——我的任务页
- renderMyTasks：列表、逾期红、7 天内到期高亮、行内「开始/完成/填进度」
- 验证：手动冒烟

### 任务 14：前端——甘特图升级
- renderGantt：行序 = 里程碑 → 阶段分组头（阶段条）→ 任务条；依赖 SVG 折线；警告黄标 tooltip
- 验证：手动冒烟

### 任务 15：前端——概览统计卡
- 项目概览加：逾期任务 / 本周到期 / WBS 完成率
- 验证：手动冒烟

### 任务 16：全量验证与文档
- `npm test` 全绿；`node --check` 全部改动文件
- README 更新（功能列表、表结构、接口）
- 重启服务，真实环境冒烟：临时项目走全链路（建阶段→任务→依赖→切 wbs→套模板→甘特→我的任务→周报），验证后清理；对「郏县妇幼」只读验证 bootstrap 无报错
- 工作日志

## 风险与回退
- tasks 不设真外键到自身，避免删除顺序问题；删除阶段级联删任务（DB CASCADE）
- 加列全部走 information_schema 检查，幂等
- 若集成测试污染生产库 → 已有独立 test 库机制，沿用
