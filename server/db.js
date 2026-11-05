const mysql = require("mysql2/promise");

/* 启动时自动建库建表；连接失败抛出带指引的错误 */
async function initDb(env) {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = env;
  // 1. 不带库名连接，创建数据库
  const conn = await mysql.createConnection({
    host: DB_HOST, port: +DB_PORT || 3306, user: DB_USER, password: DB_PASSWORD,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();

  // 2. 连接池
  const pool = mysql.createPool({
    host: DB_HOST, port: +DB_PORT || 3306, user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME, waitForConnections: true, connectionLimit: 10,
    dateStrings: true, // DATE 返回 'YYYY-MM-DD' 字符串，避免时区偏移
    decimalNumbers: true, // DECIMAL 返回数字而非字符串（实际工时）
  });

  await ensureTables(pool, DB_NAME);
  return pool;
}

async function ensureTables(pool, dbName) {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    display_name VARCHAR(50) NOT NULL DEFAULT '',
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS projects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NOT NULL DEFAULT '',
    owner VARCHAR(50) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT '筹备中',
    note TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS modules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    owner VARCHAR(50) NOT NULL DEFAULT '',
    plan_date DATE NULL,
    actual_date DATE NULL,
    status VARCHAR(20) NOT NULL DEFAULT '未开始',
    progress TINYINT NOT NULL DEFAULT 0,
    fail_reason VARCHAR(500) NOT NULL DEFAULT '',
    coord_note VARCHAR(500) NOT NULL DEFAULT '',
    note TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_modules_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS milestones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    name VARCHAR(50) NOT NULL,
    plan_date DATE NULL,
    actual_date DATE NULL,
    status VARCHAR(20) NOT NULL DEFAULT '未开始',
    note TEXT,
    sort_order TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ms_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS issues (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    module_id INT NULL,
    type VARCHAR(10) NOT NULL DEFAULT '问题',
    title VARCHAR(200) NOT NULL,
    detail TEXT,
    owner VARCHAR(50) NOT NULL DEFAULT '',
    priority VARCHAR(10) NOT NULL DEFAULT '中',
    status VARCHAR(10) NOT NULL DEFAULT '待处理',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    CONSTRAINT fk_issues_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_issues_module FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* 多用户：projects 增加 created_by（存量库平滑加列） */
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='projects' AND COLUMN_NAME='created_by'",
    [dbName]
  );
  if (!cols.length) {
    await pool.query(`ALTER TABLE projects
      ADD COLUMN created_by INT NULL AFTER status,
      ADD CONSTRAINT fk_proj_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL`);
  }

  /* 甘特图：模块增加计划开始时间（存量库平滑加列） */
  const [mc] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='modules' AND COLUMN_NAME='plan_start'",
    [dbName]
  );
  if (!mc.length) {
    await pool.query("ALTER TABLE modules ADD COLUMN plan_start DATE NULL AFTER plan_date");
  }

  /* 问题流转：指派人/提交人/计划完成/实际完成/工时/完成状况（存量库平滑加列） */
  const issueCols = [
    ["assignee_id", "ADD COLUMN assignee_id INT NULL AFTER module_id"],
    ["reporter_id", "ADD COLUMN reporter_id INT NULL AFTER assignee_id"],
    ["plan_date",   "ADD COLUMN plan_date DATE NULL AFTER detail"],
    ["actual_date", "ADD COLUMN actual_date DATE NULL AFTER plan_date"],
    ["actual_hours","ADD COLUMN actual_hours DECIMAL(6,1) NULL AFTER actual_date"],
    ["finish_note", "ADD COLUMN finish_note VARCHAR(1000) NOT NULL DEFAULT '' AFTER actual_hours"],
  ];
  for (const [col, ddl] of issueCols) {
    const [c] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='issues' AND COLUMN_NAME=?",
      [dbName, col]
    );
    if (!c.length) await pool.query("ALTER TABLE issues " + ddl);
  }

  /* 合同管理：文件存磁盘 uploads/，元数据入库 */
  await pool.query(`CREATE TABLE IF NOT EXISTS contracts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    name VARCHAR(200) NOT NULL,
    code VARCHAR(100) NOT NULL DEFAULT '',
    party VARCHAR(200) NOT NULL DEFAULT '',
    amount DECIMAL(14,2) NULL,
    sign_date DATE NULL,
    note TEXT,
    file_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(120) NOT NULL,
    file_size INT NOT NULL DEFAULT 0,
    file_mime VARCHAR(100) NOT NULL DEFAULT '',
    uploaded_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_contracts_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_contracts_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* 模块交付附件：培训签到单 / 上线确认单 / 模块验收报告等，文件存磁盘，元数据入库 */
  await pool.query(`CREATE TABLE IF NOT EXISTS module_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    module_id INT NOT NULL,
    project_id INT NOT NULL,
    category VARCHAR(20) NOT NULL DEFAULT '其他',
    title VARCHAR(200) NOT NULL DEFAULT '',
    note VARCHAR(500) NOT NULL DEFAULT '',
    file_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(120) NOT NULL,
    file_size INT NOT NULL DEFAULT 0,
    file_mime VARCHAR(100) NOT NULL DEFAULT '',
    uploaded_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mfiles_module FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
    CONSTRAINT fk_mfiles_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_mfiles_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_mfiles_module (module_id),
    INDEX idx_mfiles_project (project_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* 系统设置：键值对；大模型密钥以密文存储（AES-256-GCM） */
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    k VARCHAR(50) PRIMARY KEY,
    v TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* 周报：按项目+周（周一）唯一，重新生成时覆盖 */
  await pool.query(`CREATE TABLE IF NOT EXISTS weekly_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    content MEDIUMTEXT NOT NULL,
    source VARCHAR(10) NOT NULL DEFAULT 'template',
    model VARCHAR(60) NOT NULL DEFAULT '',
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_report_proj_week (project_id, week_start),
    CONSTRAINT fk_reports_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_reports_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* 进度记录：按日期填写，模块当前进度=最新一条 */
  await pool.query(`CREATE TABLE IF NOT EXISTS module_updates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    module_id INT NOT NULL,
    project_id INT NOT NULL,
    update_date DATE NOT NULL,
    progress TINYINT NOT NULL DEFAULT 0,
    note VARCHAR(500) NOT NULL DEFAULT '',
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_updates_module FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
    CONSTRAINT fk_updates_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    INDEX idx_updates_module (module_id, update_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ===== 排期与 WBS ===== */

  /* 模块进度来源：manual 手动 / wbs 按 WBS 任务加权自动（存量库平滑加列） */
  const [ps] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='modules' AND COLUMN_NAME='progress_source'",
    [dbName]
  );
  if (!ps.length) {
    await pool.query("ALTER TABLE modules ADD COLUMN progress_source VARCHAR(10) NOT NULL DEFAULT 'manual' AFTER progress");
  }

  /* WBS 阶段：项目 → 阶段 → 任务 */
  await pool.query(`CREATE TABLE IF NOT EXISTS phases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    plan_start DATE NULL,
    plan_end DATE NULL,
    status VARCHAR(20) NOT NULL DEFAULT '未开始',
    sort_order INT NOT NULL DEFAULT 0,
    note VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_phases_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* WBS 任务：predecessor_id 用普通列（环由应用层校验，避免外键删除顺序问题） */
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    phase_id INT NOT NULL,
    module_id INT NULL,
    name VARCHAR(200) NOT NULL,
    owner_id INT NULL,
    plan_start DATE NULL,
    plan_end DATE NULL,
    actual_start DATE NULL,
    actual_end DATE NULL,
    estimate_hours DECIMAL(6,1) NULL,
    actual_hours DECIMAL(6,1) NULL,
    status VARCHAR(20) NOT NULL DEFAULT '未开始',
    progress TINYINT NOT NULL DEFAULT 0,
    predecessor_id INT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    note VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_tasks_phase FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE,
    CONSTRAINT fk_tasks_module FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE SET NULL,
    CONSTRAINT fk_tasks_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_tasks_proj (project_id),
    INDEX idx_tasks_owner (owner_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

module.exports = { initDb };
