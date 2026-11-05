const crypto = require("crypto");

/* 密码哈希：scrypt + 随机盐，存储格式 salt:hash */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return salt + ":" + h;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, h] = String(stored).split(":");
    const h2 = crypto.scryptSync(String(pw), salt, 32).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(h2, "hex"));
  } catch (e) { return false; }
}

/* 查库认证，返回安全的用户对象（不含密码） */
async function authenticateUser(pool, username, password) {
  if (!username || !password) return null;
  const [rows] = await pool.query("SELECT * FROM users WHERE username=?", [String(username).trim()]);
  if (!rows.length) return null;
  const u = rows[0];
  if (!verifyPassword(password, u.password_hash)) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
}

function authRequired(req, res, next) {
  if (req.session && req.session.user && req.session.user.id != null) return next();
  res.status(401).json({ error: "未登录或会话已过期" });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === "admin") return next();
  res.status(403).json({ error: "需要管理员权限" });
}

module.exports = { hashPassword, verifyPassword, authenticateUser, authRequired, requireAdmin };
