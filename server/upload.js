/* 文件上传公共能力：白名单、大小限制、中文文件名修复、磁盘清理。
   合同与模块附件共用，避免两套 multer 配置漂移。 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const MAX_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOW_EXT = new Set([
  "pdf","doc","docx","xls","xlsx","ppt","pptx","txt","md","csv",
  "zip","rar","7z","jpg","jpeg","png","gif","bmp","webp",
]);

/* 项目根目录下的 uploads/（本文件位于 server/） */
function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
}

function ensureUploadDir() {
  fs.mkdirSync(uploadDir(), { recursive: true });
  return uploadDir();
}

/* 修复 multipart 文件名编码：浏览器按 UTF-8 发送，multer 按 latin1 解析导致中文乱码 */
function fixFilename(name) {
  try {
    const fixed = Buffer.from(name, "latin1").toString("utf8");
    return fixed.includes("\uFFFD") ? name : fixed;
  } catch (_) { return name; }
}

function storedPath(storedName) {
  return path.join(uploadDir(), storedName);
}

/* 删除磁盘文件：不存在或占用时静默忽略（不阻塞数据库操作） */
function removeStored(storedName) {
  if (!storedName) return;
  try { fs.unlinkSync(storedPath(storedName)); } catch (_) {}
}

function createUploader() {
  ensureUploadDir();
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now() + "-" + crypto.randomBytes(6).toString("hex") + ext);
    },
  });
  return multer({
    storage,
    limits: { fileSize: MAX_SIZE },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(1);
      if (!ALLOW_EXT.has(ext)) return cb(new Error("不支持的文件类型（." + ext + "）"));
      cb(null, true);
    },
  });
}

/* multer 错误转可读提示 */
function uploadErrorHandler(err, req, res, next) {
  if (err && (err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_UNEXPECTED_FILE" || err.message)) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "文件大小超过 50MB 限制"
      : err.code === "LIMIT_UNEXPECTED_FILE" ? "一次上传的文件数量过多（最多 10 个）"
      : err.message;
    return res.status(400).json({ error: msg });
  }
  next(err);
}

module.exports = {
  MAX_SIZE, ALLOW_EXT, uploadDir, ensureUploadDir,
  fixFilename, storedPath, removeStored, createUploader, uploadErrorHandler,
};
