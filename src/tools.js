const axios = require('axios');

/**
 * Tanya AI (Pollinations Free AI endpoint)
 */
async function askAI(prompt) {
  try {
    const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`, {
      timeout: 30000,
      headers: { 'User-Agent': 'WhatsAppBot/1.0' }
    });
    return (res.data || '').toString().trim();
  } catch (err) {
    throw new Error('AI sedang sibuk, coba beberapa saat lagi.');
  }
}

/**
 * Terjemahan Bahasa (Google Translate Free Endpoint)
 */
async function translateText(text, targetLang = 'id') {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data && res.data[0]) {
      const translated = res.data[0].map((item) => item[0]).join('');
      return translated;
    }
    throw new Error('Gagal menerjemahkan');
  } catch (err) {
    throw new Error('Gagal translate: ' + err.message);
  }
}

/**
 * Wikipedia Indonesia Summary
 */
async function getWikiSummary(query) {
  try {
    const url = `https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'WhatsAppBot/1.0' }
    });
    return {
      title: res.data.title,
      extract: res.data.extract,
      thumbnail: res.data.thumbnail ? res.data.thumbnail.source : null
    };
  } catch (err) {
    throw new Error(`Informasi tentang "${query}" tidak ditemukan di Wikipedia.`);
  }
}

/**
 * Surah Al-Qur'an (equran.id)
 */
async function getSurah(nomor) {
  try {
    const res = await axios.get(`https://equran.id/api/v2/surat/${nomor}`, { timeout: 10000 });
    const data = res.data?.data;
    if (!data) throw new Error('Surah tidak ditemukan');
    return {
      nomor: data.nomor,
      namaLatin: data.namaLatin,
      nama: data.nama,
      arti: data.arti,
      jumlahAyat: data.jumlahAyat,
      tempatTurun: data.tempatTurun,
      deskripsi: (data.deskripsi || '').replace(/<[^>]*>?/gm, '').trim()
    };
  } catch (err) {
    throw new Error(`Surah nomor ${nomor} tidak ditemukan (1 - 114).`);
  }
}

/**
 * Jadwal Sholat (api.myquran.com)
 */
async function getJadwalSholat(namaKota) {
  try {
    const cariUrl = `https://api.myquran.com/v2/sholat/kota/cari/${encodeURIComponent(namaKota)}`;
    const cariRes = await axios.get(cariUrl, { timeout: 10000 });
    const kotaList = cariRes.data?.data;
    if (!kotaList || kotaList.length === 0) {
      throw new Error(`Kota "${namaKota}" tidak ditemukan.`);
    }

    const kota = kotaList[0];
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');

    const jadwalUrl = `https://api.myquran.com/v2/sholat/jadwal/${kota.id}/${y}/${m}/${d}`;
    const jadwalRes = await axios.get(jadwalUrl, { timeout: 10000 });
    const j = jadwalRes.data?.data?.jadwal;

    return {
      kota: kota.lokasi,
      tanggal: j.tanggal,
      imsak: j.imsak,
      subuh: j.subuh,
      terbit: j.terbit,
      dhuha: j.dhuha,
      dzuhur: j.dzuhur,
      ashar: j.ashar,
      maghrib: j.maghrib,
      isya: j.isya
    };
  } catch (err) {
    throw new Error(err.message || 'Gagal mengambil jadwal sholat.');
  }
}

/**
 * Cuaca Realtime (wttr.in)
 */
async function getWeather(kota) {
  try {
    const url = `https://wttr.in/${encodeURIComponent(kota)}?format=%l:+%c+%C+%t+(Terasa+%f),+Kelembapan+%h,+Angin+%w`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'curl/7.68.0' }
    });
    return res.data.toString().trim();
  } catch (err) {
    throw new Error(`Gagal mengambil data cuaca untuk ${kota}.`);
  }
}

/**
 * TinyURL Shortener
 */
async function shortenUrl(longUrl) {
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`, { timeout: 10000 });
    return res.data.toString().trim();
  } catch (err) {
    throw new Error('Gagal memperpendek URL.');
  }
}

/**
 * QR Code Generator Buffer
 */
async function generateQrBuffer(text) {
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=15&data=${encodeURIComponent(text)}`;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000
    });
    return Buffer.from(res.data);
  } catch (err) {
    throw new Error('Gagal membuat gambar QR Code.');
  }
}

module.exports = {
  askAI,
  translateText,
  getWikiSummary,
  getSurah,
  getJadwalSholat,
  getWeather,
  shortenUrl,
  generateQrBuffer
};
