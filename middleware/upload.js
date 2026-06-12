/**
 * upload.js — multer middleware for in-memory image uploads (forwarded to Cloudinary).
 */

const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

module.exports = upload;
