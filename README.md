# 项目上线管理工作台（MySQL 版）

个人项目上线管理工具：**多项目 → 上线模块 → 里程碑（部署/测试/培训/上线/验收）→ 问题/协调/Bug/需求记录**。
数据存储在你本地的 **MySQL** 中，带单账号登录。

## 首次使用（3 步）

```bash
# 1. 安装依赖（仅首次）
cd workbench-app
npm install

# 2. 配置：复制 .env.example 为 .env，填入你的 MySQL 密码和登录密码
#    Windows: copy .env.example .env
cp .env.example .env

# 3. 启动（自动建库建表，无需手动初始化数据库）
npm start
```

打开 http://localhost:5200 ，用 `.env` 里配置的账号密码登录。

> 前置条件：本机 MySQL 服务已启动。连接失败时控制台会给出具体原因。

## 部署：让它自己一直运行

### 方式一：Docker Compose（推荐，开机自恢复，可原样搬上云）

前置：安装并启动 Docker Desktop（首次启动需手动打开一次，接受协议/启用 WSL）。

```bash
cd workbench-app
docker compose up -d        # 一键拉起 MySQL + 应用，数据存 Docker 卷
```

- 访问 http://localhost:5200 ，数据库密码/登录密码沿用 `.env` 配置
- `restart: unless-stopped`：容器崩溃自动重启，重启电脑后 Docker 起来服务自动恢复
- 数据持久化在名为 `pm-workbench-db-data` 的卷里，`docker compose down` 不丢数据
- 常用命令：`docker compose logs -f app`（看日志）、`docker compose down`（停止）、`docker compose up -d --build`（改代码后重建）

> 注意：Docker 版自带**独立的 MySQL**（数据在 Docker 卷里），与本机已有的 MySQL 是两套数据。
> 如果想让容器直接连你本机现有的 MySQL：删掉 compose 里的 `db` 服务，把 app 的 `DB_HOST` 改为 `host.docker.internal`。

### 方式二：本机 pm2 常驻（不装 Docker 时）

```bash
npm install -g pm2
cd workbench-app
pm2 start server/index.js --name pm-workbench
pm2 save
pm2 startup      # 按提示执行输出的命令，实现开机自启
```

### 方式三：Windows 开机自启（最简单，无额外依赖）

`Win+R` 输入 `shell:startup` 回车，在打开的文件夹里新建快捷方式，目标填：
```
cmd /c cd /d E:\项目管理工作台\workbench-app && npm start
```
登录 Windows 后自动启动服务（会弹一个命令行窗口，最小化即可）。

### 部署到云服务器

配置全部走 `.env`，把整个 `workbench-app` 目录上传服务器后：
- 有 Docker：`docker compose up -d`（建议加 `.env` 中 `APP_PORT` 并开放防火墙端口）
- 无 Docker：`npm install && npm start`，用 pm2 常驻，Nginx 反向代理加 HTTPS 即可

## 配置项（.env）

| 变量 | 说明 | 默认 |
|------|------|------|
| `APP_PORT` | 服务端口 | `5200` |
| `AUTH_USERNAME` | 登录账号 | `admin` |
| `AUTH_PASSWORD` | 登录密码（必填，不配置则无法登录） | 空 |
| `SESSION_SECRET` | 会话密钥（随便一串随机字符） | - |
| `DB_HOST` / `DB_PORT` | MySQL 地址 | `localhost` / `3306` |
| `DB_USER` / `DB_PASSWORD` | MySQL 账号 / 密码 | - |
| `DB_NAME` | 数据库名（自动创建） | `pm_workbench` |
| `LLM_API_KEY` | 大模型密钥兜底（**推荐改用页面录入，加密存库**） | 空 |
| `SETTINGS_SECRET` | 加密主密钥：加解密数据库里的 API Key（**改动后需重新录入密钥**） | 由启动时生成 |
| `LLM_BASE_URL` | OpenAI 兼容接口地址 | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |

## 功能

1. **项目管理**：多项目创建/编辑/删除；整体进度 = 模块进度平均值
2. **上线模块**：计划/实际上线时间、上线情况（未开始/开发中/测试中/试运行/已上线/无法上线）、手动进度、无法上线原因（必填校验）、需协调配合内容；超期未上线自动标红
3. **里程碑**：建项目自动生成 部署→测试→培训→上线→验收，时间轴展示、逾期预警
4. **记录**：问题/协调/Bug/需求 四类，优先级、状态流转、关联模块、跨项目筛选；**指派流转**：提交时可选现有用户（记录直接进入对方工作台），处理人提交「已完成」（实际完成时间/实际工时/完成状况）→ 流转给提交人测试 → 测试通过置「已解决」/ 不通过退回「处理中」；计划完成时间逾期自动标红
5. **总览**：项目卡片、即将到来的里程碑提醒、待办统计；支持 JSON 备份导出
6. **按日期记进度**：每个模块可多次登记进度（日期 + 进度% + 说明），模块当前进度 = 最新一条记录（补录旧日期不会覆盖、删除最新记录自动回退），项目进度 = 各模块当前进度平均
7. **甘特图**：按项目展示模块时间条（计划开始→计划上线，填充=当前进度，逾期标红、上线标绿）+ 里程碑菱形节点 + 今天虚线；**可勾选显示 WBS 任务行（按阶段分组、前置依赖虚线箭头、点击任务条编辑）**；点击模块进度条直接登记进度；横向可滚动
8. **多用户**：管理员 / 普通用户两种角色；管理员可在「用户管理」里增删用户、重置密码、改角色
9. **合同管理**：按项目上传合同（PDF/Word/Excel/图片/压缩包，≤50MB），记录名称/编号/金额/对方单位/签订日期/备注，支持下载（保留原文件名）、改元数据、删除（连文件一起删）；文件存 `uploads/`，元数据存 MySQL
10. **排期计划（WBS）**：项目 → 阶段 → 任务 三级拆解。阶段含计划开始/结束与状态；任务含所属阶段、可选关联上线模块、负责人、计划/实际起止、预估/实际工时、进度、状态、备注；**支持前置任务依赖**（前后置需同项目、防循环依赖，模板任务自动按顺序串成链）；任务进度 100% 自动置「已完成」并补实际完成日，置「已完成」自动满进度；**模块进度可切换为「按 WBS 加权自动计算」**（按预估工时加权，任务变动自动重算模块进度）；内置「标准上线 / 轻量上线」模板，按模块上线日**倒排**生成任务（可设缓冲天数，可放入指定阶段或自动新建「实施」阶段）；逾期/临期红黄标；三级权限（管理员/项目负责人可全改，任务负责人本人仅能改状态、进度、实际时间、工时、备注）
11. **我的任务**：跨项目汇总「分配给我的未完结任务」，按计划完成时间排序，逾期置顶，可就地更新状态/进度/实际工时；总览页显示我的待办数、逾期数、7 天内到期任务
12. **周报**：选项目 + 选周（自动吸附到周一），一键汇总该周的模块进度（含上周→本周变化）、问题/需求新增与完成、里程碑、风险与协调、下周计划，生成结构化 Markdown 周报；**配置了大模型就调用大模型润色，没配则用本地模板**；同一周重复生成会覆盖，支持历史查看、复制全文、下载 `.md`、**一键下载 Word（.docx，可直接编辑，标题/章节/表格/项目符号都排好版）**
13. **模块交付附件**：每个上线模块可上传过程材料（培训签到单 / 上线确认单 / 模块验收报告 / 测试报告 / 操作手册 / 其他），支持**一次多选批量上传（≤10 个，单个 ≤50MB）**、按原文件名下载、改附件类型与说明、删除；模块行内用 ✓/○ 徽标显示三类必备材料是否齐备（已上线模块缺料会以橙色提示）；文件存 `uploads/`、元数据存 `module_files`，删附件/模块/项目时磁盘文件同步清理（不留孤儿文件）

## 多用户与权限

| | 管理员 admin | 普通用户 user |
|---|---|---|
| 可见项目 | 全部 | 只有「自己登记的」+「负责人是自己用户名/姓名」的 |
| 用户管理 | 可以 | 入口不显示，接口返回 403 |
| 模块/里程碑/记录 | 跟随所属项目的可见性 | 同左 |

- 第一个管理员由 `.env` 的 `AUTH_USERNAME` / `AUTH_PASSWORD` 自动创建（服务启动时若账号不存在会自动补建，不会覆盖已有密码）
- 普通用户的「姓名」用于匹配项目的负责人字段——想让某人看到项目，把负责人填成他的姓名或登录账号即可
- 不能删除自己，也不能删除/降级最后一个管理员

## 大模型密钥怎么存（安全说明）

- **推荐做法**：用管理员登录 →「用户管理 → 大模型设置」录入 API Key。服务端用 **AES-256-GCM** 加密后写入 `app_settings` 表；页面和接口**不返回密钥的任何内容（连掩码也不返回）**，只显示当前使用的模型名，明文只在服务端调用模型时进入内存。
- 加密主密钥来自 `.env` 的 `SETTINGS_SECRET`（`scrypt` 派生 256 位密钥）。`.env` 已在 `.gitignore` 中，不会进版本库；数据库备份/导出即使泄露，也无法还原 API Key。
- 换 `SETTINGS_SECRET` 会导致已存密钥解密失败 → 页面会提示「无法解密」，重新录入即可（周报同时自动回退本地模板，不会中断）。
- 仍支持 `.env` 里写 `LLM_API_KEY` 作为兜底（优先级低于页面录入），但**不建议**：那是明文。
- 支持任意 OpenAI 兼容接口：DeepSeek（`https://api.deepseek.com/v1`）、通义千问（`https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`）、Kimi（`https://api.moonshot.cn/v1`）、OpenAI 等，页面里可直接改地址和模型名，并「测试连接」。

## 技术栈与结构

- 后端：Node.js + Express + mysql2 + express-session（无构建步骤）
- 前端：原生 HTML/CSS/JS（public/ 目录）
- 数据库：MySQL，11 张表（users / projects / modules / milestones / issues / module_updates / contracts / module_files / weekly_reports / phases / tasks），外键级联删除（删项目/阶段连带任务与附件）
- 大模型：任何 OpenAI 兼容的 `/chat/completions` 接口（DeepSeek / 通义千问 / Moonshot / OpenAI），Node 原生 fetch，失败自动回退本地模板
- Word 导出：`docx` 库（纯 JS，无需安装 Office / LibreOffice），把已存的 Markdown 周报转成真正的 `.docx`
- 密码：scrypt + 随机盐哈希存储，登录用常量时间比较
- 测试：`npm test`（node:test，含校验规则单测 + 接口集成测试；集成测试使用独立的 `<DB_NAME>_test` 库，不会污染生产数据；数据库不可用时自动跳过）

```
workbench-app/
├── server/
│   ├── index.js      # 入口：读 .env → 自动建库建表 → 补建管理员 → 启动
│   ├── app.js        # Express 应用工厂（路由/会话/静态托管）
│   ├── db.js         # MySQL 连接池 + 建表 + 存量库平滑加列
│   ├── auth.js       # 密码哈希 + 登录认证 + 鉴权中间件
│   ├── bootstrap.js  # 确保 .env 配置的管理员账号存在
│   ├── helpers.js    # 项目可见性 / 操作权限判定
│   ├── upload.js     # 上传公共能力：白名单/50MB 限制/中文名修复/磁盘清理
│   ├── validate.js   # 业务校验纯函数
│   ├── crypto.js     # AES-256-GCM 密钥加解密
│   ├── settings.js   # 系统设置读写（密钥密文存库）
│   ├── wbs.js        # WBS 纯函数：依赖环检测、加权进度、模板倒排
│   ├── llm.js        # OpenAI 兼容大模型客户端（未配密钥则不可用）
│   ├── weekly.js     # 周报数据聚合 + 模板 + 提示词
│   ├── docx.js       # 周报 Markdown → Word(.docx)
│   └── routes/       # users / projects / modules / milestones / issues / contracts / moduleFiles / reports
├── public/           # 登录页 + 主界面
└── test/             # 自动化测试（独立测试库）
```

## 后续云端部署

配置全部走环境变量/.env，部署到云服务器时只需：装 Node + MySQL（或用云数据库），设置好 `.env` 后 `npm start`，建议配合 pm2 常驻。
