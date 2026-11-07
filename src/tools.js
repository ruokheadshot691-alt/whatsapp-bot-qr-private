const crypto = require('crypto');

/**
 * Tanya AI dengan Dukungan Memori Percakapan (Multi-turn Chat)
 * @param {string} prompt - Pertanyaan saat ini
 * @param {Array<{role: string, content: string}>} history - Riwayat percakapan sebelumnya
 * @param {string} userId - ID pengirim untuk sesi AI
 */
async function askAI(prompt, history = [], userId = 'default') {
  // Engine 1: FreeAIOnline (GPT-4o engine dengan multi-turn messages native)
  try {
    const sRes = await fetch('https://free-ai-online.com/wp-json/mwai/v1/start_session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'default' }),
      signal: AbortSignal.timeout(8000)
    });

    if (sRes.ok) {
      const { restNonce } = await sRes.json();
      const mwaiMessages = history.map((m, idx) => ({
        id: m.id || ('msg_' + idx),
        role: m.role,
        content: m.content
      }));

      const cRes = await fetch('https://free-ai-online.com/wp-json/mwai-ui/v1/chats/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WP-Nonce': restNonce
        },
        body: JSON.stringify({
          botId: 'default',
          chatId: 'wa_' + String(userId).replace(/[^a-zA-Z0-9]/g, '_'),
          messages: mwaiMessages,
          newMessage: prompt
        }),
        signal: AbortSignal.timeout(25000)
      });

      if (cRes.ok) {
        const data = await cRes.json();
        if (data && data.reply && data.reply.trim()) {
          return data.reply.trim();
        }
      }
    }
  } catch (err) {
    console.warn('[AI Engine 1 Gagal, beralih ke Engine 2]:', err.message);
  }

  // Engine 2: UnlimitedAI (General model dengan context injection)
  try {
    let fullPrompt = prompt;
    if (history.length > 0) {
      const historyText = history
        .map((m) => (m.role === 'user' ? 'User: ' : 'AI: ') + m.content)
        .join('\n');
      fullPrompt = `Berikut adalah percakapan kita sebelumnya:\n${historyText}\n\nUser: ${prompt}\nAI:`;
    }

    const res = await fetch('https://app.unlimitedai.chat/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        chatId: crypto.randomUUID(),
        messages: [
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: fullPrompt,
            parts: [{ type: 'text', text: fullPrompt }],
            createdAt: new Date().toISOString()
          }
        ],
        selectedChatModel: 'chat-model-general',
        selectedCharacter: null,
        selectedStory: null,
        deviceId: crypto.randomUUID(),
        locale: 'id'
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (res.ok) {
      const text = await res.text();
      let reply = '';
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const p = JSON.parse(trimmed);
          if (p.type === 'delta' && p.delta) reply += p.delta;
        } catch {}
      }
      if (reply.trim()) return reply.trim();
    }
  } catch (err2) {
    console.error('[AI Engine 2 Gagal]:', err2.message);
  }

  throw new Error('Server AI sedang padat, silakan coba kirim ulang dalam beberapa detik.');
}

/**
 * Terjemahan Bahasa (Google Translate Free Endpoint)
 */
async function translateText(text, targetLang = 'id') {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data && data[0]) {
      return data[0].map((item) => item[0]).join('');
    }
    throw new Error('Format respon translate tidak sesuai');
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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'WhatsAppBot/1.0 (Mozilla/5.0)' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error('Halaman tidak ditemukan');
    const data = await res.json();
    return {
      title: data.title,
      extract: data.extract,
      thumbnail: data.thumbnail ? data.thumbnail.source : null
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
    const res = await fetch(`https://equran.id/api/v2/surat/${nomor}`, { signal: AbortSignal.timeout(10000) });
    const json = await res.json();
    const data = json?.data;
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
    const cariRes = await fetch(cariUrl, { signal: AbortSignal.timeout(10000) });
    const cariJson = await cariRes.json();
    const kotaList = cariJson?.data;
    if (!kotaList || kotaList.length === 0) {
      throw new Error(`Kota "${namaKota}" tidak ditemukan.`);
    }

    const kota = kotaList[0];
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');

    const jadwalUrl = `https://api.myquran.com/v2/sholat/jadwal/${kota.id}/${y}/${m}/${d}`;
    const jadwalRes = await fetch(jadwalUrl, { signal: AbortSignal.timeout(10000) });
    const jadwalJson = await jadwalRes.json();
    const j = jadwalJson?.data?.jadwal;

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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'curl/7.68.0' },
      signal: AbortSignal.timeout(10000)
    });
    return (await res.text()).trim();
  } catch (err) {
    throw new Error(`Gagal mengambil data cuaca untuk ${kota}.`);
  }
}

/**
 * TinyURL Shortener
 */
async function shortenUrl(longUrl) {
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`, {
      signal: AbortSignal.timeout(10000)
    });
    return (await res.text()).trim();
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
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const arrBuf = await res.arrayBuffer();
    return Buffer.from(arrBuf);
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
