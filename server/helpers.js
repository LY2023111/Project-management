/* 数据可见性：管理员看全部；普通用户看 自己创建的 OR 负责人是自己 的项目 */
async function visibleProjectIds(pool, user) {
  if (!user) return [];
  if (user.role === "admin") {
    const [rows] = await pool.query("SELECT id FROM projects");
    return rows.map(r => r.id);
  }
  const [rows] = await pool.query(
    "SELECT id FROM projects WHERE created_by=? OR (owner<>'' AND owner IN (?,?))",
    [user.id, user.username, user.displayName]
  );
  return rows.map(r => r.id);
}

/* 判断用户能否操作某个项目（增删改模块/里程碑/记录时的归属校验） */
async function canAccessProject(pool, user, projectId) {
  if (!user || !projectId) return false;
  const ids = await visibleProjectIds(pool, user);
  return ids.includes(Number(projectId));
}

module.exports = { visibleProjectIds, canAccessProject };
