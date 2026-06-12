/**
 * cloudinaryService.js — thin wrapper around the Cloudinary SDK for banner images.
 */

const cloudinary = require("../config/cloudinary");

const FOLDER = "predictx/banners";

async function uploadImage(buffer, mimetype) {
  const dataUri = `data:${mimetype};base64,${buffer.toString("base64")}`;
  const result = await cloudinary.uploader.upload(dataUri, { folder: FOLDER });
  return { url: result.secure_url, publicId: result.public_id };
}

async function deleteImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.error("[cloudinaryService] failed to delete image:", publicId, e.message);
  }
}

module.exports = { uploadImage, deleteImage };
