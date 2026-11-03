import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {config} from './config.mjs';
import {cloudinaryUpload} from './providers.mjs';

/**
 * Stores a normalised product image and returns the URL the catalogue will use.
 *
 * Cloudinary when it is configured, local disk otherwise. The fallback is kept
 * so a developer with no Cloudinary account still has a working admin, and so
 * that removing the credentials degrades instead of breaking: the same pattern
 * payments, shipping and email already follow in this codebase.
 *
 * The image arriving here has already been re-encoded to WebP by the caller, so
 * no Cloudinary transformation is requested on upload; what is stored is what
 * we produced.
 */
export async function storeImage(content, name) {
  if (config.mediaEnabled) {
    const {url, publicId, bytes} = await cloudinaryUpload(content, {
      filename: name,
      folder: config.mediaFolder,
    });
    return {url, location: `cloudinary:${publicId}`, bytes};
  }

  const dir = process.env.UPLOAD_DIR || 'uploads';
  await mkdir(dir, {recursive: true});
  await writeFile(path.join(dir, name), content);
  return {url: `/uploads/${name}`, location: `disk:${name}`, bytes: content.length};
}
