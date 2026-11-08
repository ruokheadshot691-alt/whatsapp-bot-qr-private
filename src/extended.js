const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

/**
 * 1. QUOTE CHAT STICKER (.qc)
 * Membuat stiker gelembung chat estetik dengan nama pengirim dan teks
 */
function makeQcSticker(text, name = 'Seseorang') {
  const clean = String(text || '').trim().slice(0, 160);
  const cleanName = String(name || 'Seseorang').trim().replace(/['"]/g, '').slice(0, 24);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc_'));
  const txtPath = path.join(tmpDir, 'qc.txt');
  const outPath = path.join(tmpDir, 'qc.webp');

  try {
    fs.writeFileSync(txtPath, clean, 'utf8');
    // FFmpeg menggambar canvas gelembung chat gelap transparan dengan aksen hijau WA
    const cmd = `ffmpeg -y -f lavfi -i "color=c=black@0:s=512x512:d=1" -vf "drawbox=x=24:y=100:w=464:h=300:color=#1f2c34@1:t=fill,drawbox=x=24:y=100:w=464:h=300:color=#2a3942@1:t=3,drawtext=text='${cleanName}':x=50:y=130:fontcolor=#00a884:fontsize=30,drawtext=textfile='${txtPath}':x=50:y=180:fontcolor=white:fontsize=24:line_spacing=6" -vframes 1 -vcodec libwebp -lossless 0 -q:v 75 "${outPath}"`;
    execSync(cmd, { stdio: 'pipe' });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 2. STICKER MEME (.smeme)
 * Menambahkan teks meme Impact putih bergaris hitam di atas foto dan mengubah jadi stiker
 */
function makeSmemeSticker(imageBuffer, topText = '', bottomText = '') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smeme_'));
  const inPath = path.join(tmpDir, 'in.jpg');
  const topPath = path.join(tmpDir, 'top.txt');
  const btmPath = path.join(tmpDir, 'btm.txt');
  const outPath = path.join(tmpDir, 'out.webp');

  try {
    fs.writeFileSync(inPath, imageBuffer);
    fs.writeFileSync(topPath, String(topText || '').toUpperCase().trim(), 'utf8');
    fs.writeFileSync(btmPath, String(bottomText || '').toUpperCase().trim(), 'utf8');

    let vf = `scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=black@0`;
    if (topText) {
      vf += `,drawtext=textfile='${topPath}':fontcolor=white:bordercolor=black:borderw=4:fontsize=38:x=(w-text_w)/2:y=20`;
    }
    if (bottomText) {
      vf += `,drawtext=textfile='${btmPath}':fontcolor=white:bordercolor=black:borderw=4:fontsize=38:x=(w-text_w)/2:y=h-text_h-20`;
    }

    const cmd = `ffmpeg -y -i "${inPath}" -vf "${vf}" -vframes 1 -vcodec libwebp -lossless 0 -q:v 75 "${outPath}"`;
    execSync(cmd, { stdio: 'pipe' });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 3. TTP (.ttp) - Text to Picture Sticker Statis
 */
function makeTtpSticker(text) {
  const clean = String(text || '').trim().slice(0, 50);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttp_'));
  const txtPath = path.join(tmpDir, 'text.txt');
  const outPath = path.join(tmpDir, 'ttp.webp');

  try {
    fs.writeFileSync(txtPath, clean, 'utf8');
    const cmd = `ffmpeg -y -f lavfi -i color=c=black@0:s=512x512:d=1 -vf "drawtext=textfile='${txtPath}':fontcolor=#00e5ff:bordercolor=black:borderw=4:fontsize=52:x=(w-text_w)/2:y=(h-text_h)/2" -vframes 1 -vcodec libwebp -lossless 0 -q:v 75 "${outPath}"`;
    execSync(cmd, { stdio: 'pipe' });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 4. ATTP (.attp) - Animated Rainbow Text Sticker
 */
function makeAttpSticker(text) {
  const clean = String(text || '').trim().slice(0, 50);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attp_'));
  const txtPath = path.join(tmpDir, 'text.txt');
  const outPath = path.join(tmpDir, 'attp.webp');
  const colors = ['#ff0000', '#ff7700', '#ffff00', '#00ff00', '#00ffff', '#0055ff', '#ff00ff'];

  try {
    fs.writeFileSync(txtPath, clean, 'utf8');
    for (let i = 0; i < colors.length; i++) {
      const pngPath = path.join(tmpDir, `f_${String(i).padStart(3, '0')}.png`);
      const cmd = `ffmpeg -y -f lavfi -i color=c=black@0:s=512x512:d=1 -vf "drawtext=textfile='${txtPath}':fontcolor=${colors[i]}:bordercolor=black:borderw=4:fontsize=50:x=(w-text_w)/2:y=(h-text_h)/2" -vframes 1 "${pngPath}"`;
      execSync(cmd, { stdio: 'pipe' });
    }
    const animCmd = `ffmpeg -y -framerate 6 -i "${tmpDir}/f_%03d.png" -vcodec libwebp -lossless 0 -q:v 70 -loop 0 -an "${outPath}"`;
    execSync(animCmd, { stdio: 'pipe' });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 5. TEXT TO SPEECH (.tts)
 * Google TTS resmi dikonversi ke Opus OGG (format Voice Note WhatsApp asli)
 */
async function getGoogleTts(text, lang = 'id') {
  const clean = String(text || '').trim().slice(0, 300);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=${lang}&client=tw-ob`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Google TTS gagal (${res.status})`);
  const mp3Buf = Buffer.from(await res.arrayBuffer());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts_'));
  const inMp3 = path.join(tmpDir, 'in.mp3');
  const outOgg = path.join(tmpDir, 'out.ogg');

  try {
    fs.writeFileSync(inMp3, mp3Buf);
    execSync(`ffmpeg -y -i "${inMp3}" -c:a libopus -b:a 48k "${outOgg}"`, { stdio: 'pipe' });
    return fs.readFileSync(outOgg);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 6. AUDIO EFFECTS (.bass, .slow, .chipmunk, .robot)
 */
function applyAudioEffect(audioBuffer, effect = 'bass') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiofx_'));
  const inPath = path.join(tmpDir, 'in.audio');
  const outPath = path.join(tmpDir, 'out.ogg');

  let filter = '';
  switch (effect.toLowerCase()) {
    case 'bass':
      filter = 'equalizer=f=60:width_type=h:width=50:g=15';
      break;
    case 'slow':
      filter = 'atempo=0.8,asetrate=44100*0.8';
      break;
    case 'chipmunk':
      filter = 'asetrate=44100*1.4,atempo=1/1.4';
      break;
    case 'robot':
      filter = 'afftfilt="real=hypot(re,im)*sin(0)":imag="hypot(re,im)*cos(0)"';
      break;
    default:
      filter = 'equalizer=f=60:width_type=h:width=50:g=12';
  }

  try {
    fs.writeFileSync(inPath, audioBuffer);
    execSync(`ffmpeg -y -i "${inPath}" -af "${filter}" -c:a libopus "${outPath}"`, { stdio: 'pipe' });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 7. BMKG REALTIME GEMPA (.gempa)
 */
async function getGempaBmkg() {
  const res = await fetch('https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json');
  if (!res.ok) throw new Error('Gagal menghubungi server BMKG');
  const data = await res.json();
  const g = data.Infogempa.gempa;
  const caption =
    `🚨 *INFORMASI GEMPA TERKINI (BMKG)* 🚨\n\n` +
    `📍 *Wilayah:* ${g.Wilayah}\n` +
    `📅 *Tanggal:* ${g.Tanggal}\n` +
    `⏰ *Waktu:* ${g.Jam}\n` +
    `⚡ *Kekuatan:* ${g.Magnitude} SR\n` +
    `🌊 *Kedalaman:* ${g.Kedalaman}\n` +
    `🌐 *Koordinat:* ${g.Coordinates} (${g.Lintang} - ${g.Bujur})\n` +
    `⚠️ *Potensi:* ${g.Potensi}\n` +
    (g.Dirasakan ? `📢 *Dirasakan:* ${g.Dirasakan}\n` : '') +
    `\n_Sumber: BMKG Indonesia_`;

  const mapUrl = `https://data.bmkg.go.id/DataMKG/TEWS/${g.Shakemap}`;
  return { caption, mapUrl };
}

/**
 * 8. SCREENSHOT WEBSITE (.ssweb)
 */
async function getWebScreenshot(url) {
  let target = url.trim();
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    target = 'https://' + target;
  }
  const apiUrl = `https://image.thum.io/get/width/1024/crop/800/${target}`;
  const res = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Gagal mengambil screenshot website');
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 9. TIKTOK DOWNLOADER (.tt / .tiktok)
 */
async function getTikTokVideo(url) {
  const cleanUrl = url.trim();
  const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error('Server TikTok downloader sedang tidak dapat dihubungi');
  const data = await res.json();
  if (data.code === 0 && data.data) {
    return {
      title: data.data.title || 'TikTok Video',
      author: data.data.author?.nickname || 'Creator',
      videoUrl: data.data.play || data.data.wmplay,
      cover: data.data.cover
    };
  }
  throw new Error(data.msg || 'Gagal mengambil video TikTok. Pastikan link video valid dan publik.');
}

/**
 * 10. IMAGE SEARCH (.pin / .img)
 */
async function searchImage(query) {
  const clean = query.trim();
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(clean)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Gagal mencari gambar');
  const data = await res.json();
  const pages = Object.values(data?.query?.pages || {});
  const images = pages.map((p) => p?.imageinfo?.[0]?.url).filter((u) => u && !u.endsWith('.svg'));
  if (images.length === 0) throw new Error(`Gambar untuk "${clean}" tidak ditemukan.`);
  return images[Math.floor(Math.random() * images.length)];
}

/**
 * 11. TEBAK KATA GAME
 */
const TEBAK_KATA_BANK = [
  { soal: 'Ibukota negara Indonesia yang berada di pulau Jawa', jawaban: 'jakarta', clue: 'J _ _ _ _ _ A' },
  { soal: 'Hewan mamalia terbesar di dunia yang hidup di lautan', jawaban: 'paus biru', clue: 'P _ _ S   B _ _ U' },
  { soal: 'Planet merah yang merupakan planet keempat dari matahari', jawaban: 'mars', clue: 'M _ _ S' },
  { soal: 'Benda langit yang mengelilingi bumi dan menyebabkan pasang surut air laut', jawaban: 'bulan', clue: 'B _ _ _ N' },
  { soal: 'Alat musik tradisional petik dari Nusa Tenggara Timur (NTT)', jawaban: 'sasando', clue: 'S _ _ _ N _ O' },
  { soal: 'Senjata khas suku Madura yang berbentuk melengkung', jawaban: 'celurit', clue: 'C _ _ _ R _ T' },
  { soal: 'Sungai terpanjang di Indonesia yang berada di Kalimantan Barat', jawaban: 'kapuas', clue: 'K _ _ _ _ S' },
  { soal: 'Gunung tertinggi di pulau Jawa', jawaban: 'semeru', clue: 'S _ _ _ R _' },
  { soal: 'Mata uang resmi negara Jepang', jawaban: 'yen', clue: 'Y _ N' },
  { soal: 'Bahasa pemrograman yang logonya berupa ular', jawaban: 'python', clue: 'P _ _ _ _ N' },
  { soal: 'Presiden pertama Republik Indonesia yang membacakan teks proklamasi', jawaban: 'soekarno', clue: 'S _ _ K _ _ N _' },
  { soal: 'Danau vulkanik terbesar di Asia Tenggara yang berada di Sumatera Utara', jawaban: 'danau toba', clue: 'D _ _ _ U   T _ _ A' },
  { soal: 'Makanan khas Palembang yang terbuat dari olahan ikan dan sagu', jawaban: 'pempek', clue: 'P _ _ P _ K' },
  { soal: 'Candi Buddha terbesar di dunia yang terletak di Magelang, Jawa Tengah', jawaban: 'borobudur', clue: 'B _ _ _ B _ _ _ R' },
  { soal: 'Pulau di Indonesia yang terkenal dengan julukan Pulau Dewata', jawaban: 'bali', clue: 'B _ _ I' }
];

function getRandomTebakKata() {
  return TEBAK_KATA_BANK[Math.floor(Math.random() * TEBAK_KATA_BANK.length)];
}

module.exports = {
  makeQcSticker,
  makeSmemeSticker,
  makeTtpSticker,
  makeAttpSticker,
  getGoogleTts,
  applyAudioEffect,
  getGempaBmkg,
  getWebScreenshot,
  getTikTokVideo,
  searchImage,
  getRandomTebakKata
};
