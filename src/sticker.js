const sharp = require('sharp');

/**
 * Mengonversi buffer gambar biasa menjadi stiker resmi Discord (PNG 320x320)
 * Sesuai spesifikasi Discord Guild Sticker:
 * - Ukuran tepat 320x320 px
 * - Format PNG (dengan transparansi jika ada)
 * - Ukuran file maksimal < 512 KB
 */
async function makeDiscordSticker(imageBuffer) {
  try {
    // 1. Coba konversi dan resize tepat ke 320x320 PNG
    let pngBuffer = await sharp(imageBuffer)
      .resize(320, 320, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 } // transparan
      })
      .png({ compressionLevel: 9 })
      .toBuffer();

    // 2. Jika ukuran file mendekati batas Discord (512 KB), optimasi kompresi palette
    if (pngBuffer.length > 500 * 1024) {
      pngBuffer = await sharp(imageBuffer)
        .resize(320, 320, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png({ palette: true, quality: 80, compressionLevel: 9 })
        .toBuffer();
    }

    return pngBuffer;
  } catch (err) {
    throw new Error('Gagal memproses gambar ke format stiker Discord (320x320): ' + err.message);
  }
}

/**
 * Mengonversi buffer gambar menjadi buffer stiker WebP 512x512 (kompatibilitas pesan)
 */
async function makeSticker(imageBuffer) {
  try {
    const webpBuffer = await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();

    return webpBuffer;
  } catch (err) {
    throw new Error('Gagal memproses gambar ke stiker: ' + err.message);
  }
}

/**
 * Mengonversi buffer stiker WebP kembali menjadi buffer gambar JPEG/PNG
 */
async function stickerToImage(webpBuffer) {
  try {
    const imgBuffer = await sharp(webpBuffer)
      .jpeg({ quality: 90 })
      .toBuffer();
    return imgBuffer;
  } catch (err) {
    throw new Error('Gagal mengonversi stiker ke gambar: ' + err.message);
  }
}

module.exports = { makeDiscordSticker, makeSticker, stickerToImage };
