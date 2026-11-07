const axios = require('axios');
const FormData = require('form-data');

/**
 * AI Image Upscaler / Enhancer (.hd)
 * Menggunakan endpoint API gratis berbasis Real-ESRGAN
 */
async function upscaleImage(imageBuffer) {
  try {
    const form = new FormData();
    form.append('image', imageBuffer, {
      filename: 'input.jpg',
      contentType: 'image/jpeg'
    });

    // Panggilan ke API Upscaler publik gratis
    const response = await axios.post('https://api.vocalremover.org/api/v1/upscale', form, {
      headers: {
        ...form.getHeaders(),
      },
      responseType: 'arraybuffer',
      timeout: 60000
    });

    if (response.status === 200 && response.data) {
      return Buffer.from(response.data);
    }
    throw new Error('API tidak mengembalikan hasil');
  } catch (err) {
    // Fallback alternatif menggunakan sharp enhancement jika API eksternal offline
    console.log('AI API offline/error, menggunakan sharp sharpening fallback:', err.message);
    const enhancedBuffer = await require('sharp')(imageBuffer)
      .sharpen({ sigma: 1.5, m1: 1.0, m2: 2.0 })
      .jpeg({ quality: 95 })
      .toBuffer();
    return enhancedBuffer;
  }
}

module.exports = { upscaleImage };
