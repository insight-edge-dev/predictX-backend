/**
 * cloudinaryService.js — thin wrapper around the Cloudinary SDK for image uploads.
 */

const cloudinary = require("../config/cloudinary");

async function uploadImage(buffer, mimetype, folder = "predictx/banners") {
  const dataUri = `data:${mimetype};base64,${buffer.toString("base64")}`;
  const result = await cloudinary.uploader.upload(dataUri, { folder });
  return { url: result.secure_url, publicId: result.public_id };
}

async function uploadAvatar(buffer, mimetype, oldPublicId = null) {
  const dataUri = `data:${mimetype};base64,${buffer.toString("base64")}`;
  const result  = await cloudinary.uploader.upload(dataUri, {
    folder:             "predictx/avatars",
    transformation:     [{ width: 400, height: 400, crop: "fill", gravity: "face" }],
    format:             "webp",
    quality:            "auto:good",
  });
  if (oldPublicId) {
    await deleteImage(oldPublicId);
  }
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

module.exports = { uploadImage, uploadAvatar, deleteImage };
