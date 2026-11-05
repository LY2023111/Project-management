/* 入口：加载 .env → 连接 MySQL（自动建库建表）→ 启动 HTTP 服务 */
require("dotenv").config();

const { initDb } = require("./db");
const { createApp } = require("./app");

(async () => {
  if (!process.env.DB_PASSWORD) {
    console.error("✗ 未配置数据库：请复制 .env.example 为 .env 并填入 MySQL 密码");
    process.exit(1);
  }
  let pool;
  try {
    pool = await initDb(process.env);
    console.log("✓ MySQL 连接成功，数据库/表结构已就绪");
  } catch (e) {
    console.error("✗ 数据库连接失败：" + (e.code || e.message));
    console.error("  请检查 .env 中的 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME");
    console.error("  以及 MySQL 服务是否已启动。");
    process.exit(1);
  }

  /* 确保 .env 配置的管理员账号存在（首次启动或误删后自动补建） */
  const { ensureAdmin } = require("./bootstrap");
  await ensureAdmin(pool, process.env);

  const app = createApp(pool, process.env);
  const port = +process.env.APP_PORT || 5200;
  app.listen(port, () => {
    console.log(`✓ 项目上线管理工作台已启动: http://localhost:${port}`);
    console.log(`  登录账号: ${process.env.AUTH_USERNAME || "admin"}`);
  });
})();
