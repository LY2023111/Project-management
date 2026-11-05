const { hashPassword } = require("./auth");

/* 确保 .env 里配置的管理员账号存在（首次启动或账号被删后自动补建） */
async function ensureAdmin(pool, env) {
  const username = String(env.AUTH_USERNAME || "admin").trim();
  const password = String(env.AUTH_PASSWORD || "");
  if (!username || !password) return null;

  const [rows] = await pool.query("SELECT id, role FROM users WHERE username=?", [username]);
  if (rows.length) {
    // 已存在：保证它是管理员，避免被误改后无人可管理
    if (rows[0].role !== "admin") {
      await pool.query("UPDATE users SET role='admin' WHERE id=?", [rows[0].id]);
      console.log(`✓ 已将账号 ${username} 提升为管理员`);
    }
    return rows[0].id;
  }
  const [ins] = await pool.query(
    "INSERT INTO users(username,password_hash,display_name,role) VALUES(?,?,?,?)",
    [username, hashPassword(password), "管理员", "admin"]
  );
  console.log(`✓ 已初始化管理员账号: ${username}`);
  return ins.insertId;
}

module.exports = { ensureAdmin };
