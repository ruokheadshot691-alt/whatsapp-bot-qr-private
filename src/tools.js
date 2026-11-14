const crypto = require('crypto');

/**
 * Tanya AI dengan memori dan persona khusus per pengguna.
 * Provider gratis bisa berubah sewaktu-waktu, jadi fungsi ini mencoba dua engine.
 */
function looksLikeChinese(text) {
  const chars = (String(text).match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || []).length;
  return chars >= 4 && chars / Math.max(String(text).length, 1) > 0.08;
}

function aiSystemPrompt(persona = '') {
  const selectedPersona = String(persona || '').trim();
  return [
    'Kamu adalah asisten Discord yang ramah, cerdas, dan mengikuti instruksi pengguna.',
    'Balas selalu dalam Bahasa Indonesia, kecuali pengguna secara jelas meminta bahasa lain atau sedang meminta terjemahan.',
    'Jangan pernah menjawab dalam Bahasa Mandarin/Tionghoa kecuali pengguna meminta bahasa itu secara eksplisit.',
    selectedPersona ? `Persona yang harus kamu perankan secara konsisten: ${selectedPersona}` : ''
  ].filter(Boolean).join('\n');
}

async function askUnlimited(prompt, history, persona) {
  const messages = [
    { role: 'system', content: aiSystemPrompt(persona) },
    ...history.filter((m) => ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, content: String(m.content) })),
    { role: 'user', content: prompt }
  ];
  const res = await fetch('https://app.unlimitedai.chat/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify({
      chatId: crypto.randomUUID(),
      messages: messages.map((m) => ({
        ...m,
        id: crypto.randomUUID(),
        parts: [{ type: 'text', text: m.content }],
        createdAt: new Date().toISOString()
      })),
      selectedChatModel: 'chat-model-general',
      selectedCharacter: null,
      selectedStory: null,
      deviceId: crypto.randomUUID(),
      locale: 'id'
    }),
    signal: AbortSignal.timeout(22000)
  });
  if (!res.ok) throw new Error(`AI utama merespons HTTP ${res.status}`);
  const raw = await res.text();
  let reply = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const part = JSON.parse(trimmed);
      if (part.type === 'delta' && part.delta) reply += part.delta;
      else if (part.type === 'text-delta' && part.textDelta) reply += part.textDelta;
      else if (part.type === 'error' && part.error) throw new Error(String(part.error));
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
  }
  if (!reply.trim()) throw new Error('AI utama tidak mengirim jawaban');
  return reply.trim();
}

async function askFreeAI(prompt, history, userId, persona) {
  const sRes = await fetch('https://free-ai-online.com/wp-json/mwai/v1/start_session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: 'default' }),
    signal: AbortSignal.timeout(8000)
  });
  if (!sRes.ok) throw new Error(`AI cadangan gagal membuka sesi (HTTP ${sRes.status})`);
  const { restNonce } = await sRes.json();
  if (!restNonce) throw new Error('AI cadangan tidak mengirim token sesi');
  const messages = [
    { id: 'system_instruction', role: 'system', content: aiSystemPrompt(persona) },
    ...history.map((m, idx) => ({ id: m.id || `msg_${idx}`, role: m.role, content: m.content }))
  ];
  const cRes = await fetch('https://free-ai-online.com/wp-json/mwai-ui/v1/chats/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': restNonce },
    body: JSON.stringify({
      botId: 'default',
      chatId: 'wa_' + String(userId).replace(/[^a-zA-Z0-9]/g, '_'),
      messages,
      newMessage: prompt
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!cRes.ok) throw new Error(`AI cadangan merespons HTTP ${cRes.status}`);
  const data = await cRes.json();
  if (!data?.reply?.trim()) throw new Error('AI cadangan tidak mengirim jawaban');
  return data.reply.trim();
}

async function askAI(prompt, history = [], userId = 'default', persona = '') {
  const errors = [];
  // Engine ini menghormati system prompt, termasuk Bahasa Indonesia dan persona.
  try {
    let answer = await askUnlimited(prompt, history, persona);
    if (looksLikeChinese(answer)) {
      answer = await askUnlimited(
        `Jawab ulang pertanyaan berikut hanya dalam Bahasa Indonesia. Jangan gunakan aksara Mandarin/Tionghoa. Pertanyaan: ${prompt}`,
        history,
        persona
      );
    }
    if (looksLikeChinese(answer)) throw new Error('AI mengirim jawaban dalam bahasa yang tidak sesuai');
    return answer;
  } catch (err) {
    errors.push(err.message);
    console.warn('[AI utama gagal, mencoba AI cadangan]:', err.message);
  }

  try {
    const answer = await askFreeAI(prompt, history, userId, persona);
    if (looksLikeChinese(answer)) throw new Error('AI cadangan mengirim jawaban dalam bahasa yang tidak sesuai');
    return answer;
  } catch (err) {
    errors.push(err.message);
    console.warn('[AI cadangan juga gagal]:', err.message);
  }
  throw new Error('AI sedang tidak bisa diakses. Coba lagi beberapa saat; cek koneksi dan kuota layanan gratis.');
}

/**
 * Terjemahan: MyMemory terlebih dahulu (pakai autodetect, bukan kode sumber auto),
 * lalu Google Translate GTX. Memeriksa content-type/status agar HTML error tidak
 * berubah menjadi pesan JSON parse yang membingungkan.
 */
async function translateText(text, targetLang = 'id') {
  const langMap = {
    jp: 'ja', japan: 'ja', jepang: 'ja',
    eng: 'en', english: 'en', inggris: 'en',
    indo: 'id', indonesia: 'id',
    kr: 'ko', korea: 'ko', korean: 'ko',
    cn: 'zh-CN', zh: 'zh-CN', china: 'zh-CN', mandarin: 'zh-CN',
    arab: 'ar', arabic: 'ar',
    german: 'de', jerman: 'de', french: 'fr', prancis: 'fr',
    spanish: 'es', spanyol: 'es', russian: 'ru', rusia: 'ru'
  };
  const input = String(text || '').trim();
  if (!input) throw new Error('Masukkan teks yang ingin diterjemahkan.');
  const requested = String(targetLang || 'id').trim().toLowerCase();
  const target = langMap[requested] || requested;
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(target)) {
    throw new Error(`Kode bahasa tidak valid: ${targetLang}`);
  }
  const failures = [];

  // MyMemory uses "autodetect" as the source-language code.
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(input)}&langpair=${encodeURIComponent(`autodetect|${target}`)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    if (!contentType.includes('json')) throw new Error('MyMemory mengirim respons non-JSON');
    const data = await res.json();
    const result = data?.responseData?.translatedText;
    if (data?.responseStatus === 200 && result && !/^\s*['"`].*invalid/i.test(result)) return result.trim();
    throw new Error(data?.responseDetails || 'Tidak ada hasil dari MyMemory');
  } catch (err) {
    failures.push(err.message);
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(input)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(12000)
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    if (!contentType.includes('json')) throw new Error('Google Translate mengirim halaman HTML, bukan hasil terjemahan');
    const data = await res.json();
    const result = Array.isArray(data?.[0]) ? data[0].map((part) => part?.[0] || '').join('') : '';
    if (result.trim()) return result.trim();
    throw new Error('Google Translate tidak mengembalikan hasil');
  } catch (err) {
    failures.push(err.message);
  }
  throw new Error(`Layanan terjemahan sedang tidak tersedia. Coba lagi nanti. (${failures.join('; ')})`);
}

/**
 * Wikipedia Indonesia Summary
 */
async function getWikiSummary(query) {
  try {
    const url = `https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DiscordBot/1.0 (Mozilla/5.0)' },
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
