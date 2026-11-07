const sharp = require('sharp');

/**
 * Mengonversi buffer gambar biasa menjadi buffer stiker WebP 512x512
 * Memastikan kompatibilitas penuh dengan spesifikasi stiker WhatsApp
 */
async function makeSticker(imageBuffer) {
  try {
    const webpBuffer = await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 } // transparan
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

module.exports = { makeSticker, stickerToImage };
