const querystring = require('querystring');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const sharp = require('sharp');

/**
 * 1. QUOTE CHAT STICKER (.qc)
 * Membuat stiker gelembung chat estetik WhatsApp dengan avatar/inisial, nama pengirim, kutipan teks rapi, dan timestamp
 */
function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const AUTHOR_COLORS = [
  '#00a884', '#53bdeb', '#ff9f1c', '#a855f7',
  '#f43f5e', '#2dd4bf', '#fbbf24', '#38bdf8'
];

function stringToColor(str) {
  let hash = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    hash = s.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AUTHOR_COLORS[Math.abs(hash) % AUTHOR_COLORS.length];
}

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function wrapText(text, maxCharsPerLine = 28, maxLines = 7) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + (currentLine ? ' ' : '') + word).length <= maxCharsPerLine) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      if (word.length > maxCharsPerLine) {
        let remaining = word;
        while (remaining.length > maxCharsPerLine) {
          lines.push(remaining.slice(0, maxCharsPerLine));
          remaining = remaining.slice(maxCharsPerLine);
          if (lines.length >= maxLines) break;
        }
        currentLine = remaining;
      } else {
        currentLine = word;
      }
    }
    if (lines.length >= maxLines) break;
  }
  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(1, maxCharsPerLine - 3)) + '...';
  }
  return lines.length ? lines : ['...'];
}

async function makeQcSticker(text, name = 'Seseorang', avatarBuffer = null) {
  const cleanName = String(name || 'Seseorang').trim().slice(0, 25);
  const cleanText = String(text || '').trim().slice(0, 250);
  const color = stringToColor(cleanName);
  const initials = getInitials(cleanName);

  const lines = wrapText(cleanText, 28, 7);
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const avatarSize = 54;
  const cardWidth = 464;
  const cardX = 24;

  const headerHeight = 64;
  const lineHeight = 30;
  const textBlockHeight = lines.length * lineHeight;
  const footerHeight = 28;
  const innerPadding = 20;

  const cardHeight = Math.min(464, Math.max(140, innerPadding + headerHeight + textBlockHeight + footerHeight + 10));
  const cardY = Math.max(20, Math.round((512 - cardHeight) / 2));

  let circularAvatarBuffer = null;
  if (avatarBuffer && Buffer.isBuffer(avatarBuffer)) {
    try {
      const circleMask = Buffer.from(
        `<svg width="${avatarSize}" height="${avatarSize}"><circle cx="${avatarSize / 2}" cy="${avatarSize / 2}" r="${avatarSize / 2}" fill="#000"/></svg>`
      );
      circularAvatarBuffer = await sharp(avatarBuffer)
        .resize(avatarSize, avatarSize, { fit: 'cover' })
        .composite([{ input: circleMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
    } catch (e) {
      circularAvatarBuffer = null;
    }
  }

  const avatarLeft = cardX + innerPadding;
  const avatarTop = cardY + innerPadding;
  const nameLeft = avatarLeft + avatarSize + 14;
  const nameY = avatarTop + 34;

  const textStartX = cardX + innerPadding + 4;
  const textStartY = avatarTop + avatarSize + 24;

  const timeX = cardX + cardWidth - innerPadding - 40;
  const timeY = cardY + cardHeight - 16;
  const checkX = timeX + 26;

  const textTspans = lines
    .map((line, idx) => `<tspan x="${textStartX}" dy="${idx === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join('\n');

  const avatarSvgPart = circularAvatarBuffer
    ? ''
    : `<circle cx="${avatarLeft + avatarSize / 2}" cy="${avatarTop + avatarSize / 2}" r="${avatarSize / 2}" fill="${color}" />
       <text x="${avatarLeft + avatarSize / 2}" y="${avatarTop + avatarSize / 2 + 7}" fill="#ffffff" font-size="20" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" text-anchor="middle">${escapeXml(initials)}</text>`;

  const svg = `
  <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#202c33"/>
        <stop offset="100%" stop-color="#182229"/>
      </linearGradient>
      <filter id="shadow" x="-5%" y="-5%" width="110%" height="115%">
        <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.45"/>
      </filter>
    </defs>

    <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="22" ry="22" fill="url(#bgGrad)" stroke="#2f3b43" stroke-width="2" filter="url(#shadow)"/>
    <rect x="${cardX + 4}" y="${cardY + 16}" width="4" height="${cardHeight - 32}" rx="2" ry="2" fill="${color}" opacity="0.85"/>

    ${avatarSvgPart}

    <text x="${nameLeft}" y="${nameY}" fill="${color}" font-size="21" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">${escapeXml(cleanName)}</text>
    <text x="${nameLeft}" y="${nameY + 18}" fill="#8696a0" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">Quote Message</text>

    <text x="${textStartX}" y="${textStartY}" fill="#e9edef" font-size="22" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
      ${textTspans}
    </text>

    <text x="${timeX}" y="${timeY}" fill="#8696a0" font-size="13" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" text-anchor="end">${timeStr}</text>
    <path d="M ${checkX} ${timeY - 8} l 3 3 l 7 -7 M ${checkX + 4} ${timeY - 8} l 3 3 l 7 -7" stroke="#53bdeb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>
  `.trim();

  try {
    let img = sharp(Buffer.from(svg));
    if (circularAvatarBuffer) {
      img = img.composite([{ input: circularAvatarBuffer, left: avatarLeft, top: avatarTop }]);
    }
    return await img.webp({ quality: 90, effort: 4 }).toBuffer();
  } catch (err) {
    console.error('[QC] Gagal render dengan sharp SVG:', err.message);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc_'));
    const txtPath = path.join(tmpDir, 'qc.txt');
    const outPath = path.join(tmpDir, 'qc.webp');
    try {
      fs.writeFileSync(txtPath, cleanText.slice(0, 160), 'utf8');
      const safeName = cleanName.replace(/['"]/g, '');
      const cmd = `ffmpeg -y -f lavfi -i "color=c=black@0:s=512x512:d=1" -vf "drawbox=x=24:y=100:w=464:h=300:color=#1f2c34@1:t=fill,drawbox=x=24:y=100:w=464:h=300:color=#2a3942@1:t=3,drawtext=text='${safeName}':x=50:y=130:fontcolor=#00a884:fontsize=30,drawtext=textfile='${txtPath}':x=50:y=180:fontcolor=white:fontsize=24:line_spacing=6" -vframes 1 -vcodec libwebp -lossless 0 -q:v 75 "${outPath}"`;
      execSync(cmd, { stdio: 'pipe' });
      return fs.readFileSync(outPath);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
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
function detectAudioExtension(buffer) {
  if (!buffer || buffer.length < 4) return '.ogg';
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return '.ogg';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return '.mp3';
  if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return '.mp3';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return '.wav';
  if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return '.m4a';
  return '.ogg';
}

function applyAudioEffect(audioBuffer, effect = 'bass') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiofx_'));
  const ext = detectAudioExtension(audioBuffer);
  const inPath = path.join(tmpDir, `in${ext}`);
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
    try {
      execSync(`ffmpeg -y -i "${inPath}" -vn -af "${filter}" -c:a libopus -b:a 64k -ar 48000 -ac 1 "${outPath}"`, { stdio: 'pipe' });
    } catch (e1) {
      execSync(`ffmpeg -y -i "${inPath}" -vn -af "${filter}" -ar 48000 -ac 1 "${outPath}"`, { stdio: 'pipe' });
    }
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
async function searchImages(query, limit = 6) {
  const clean = String(query || '').trim();
  if (!clean) throw new Error('Kata kunci tidak boleh kosong');

  const images = [];

  // 1. Pencarian Pinterest (HD JPEG/PNG)
  try {
    const csrf = crypto.randomBytes(16).toString('hex');
    const options = { query: clean, scope: 'pins', rs: 'typed' };
    const params = new URLSearchParams({
      data: JSON.stringify({ options }),
      source_url: `/search/pins/?q=${encodeURIComponent(clean)}`
    });

    const url = 'https://www.pinterest.com/resource/BaseSearchResource/get/?' + params.toString();
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/javascript, */*, q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-APP-VERSION': 'a89153f',
        'X-Pinterest-AppState': 'active',
        'X-Pinterest-PWS-Handler': 'www/[username].js',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Cookie': `csrftoken=${csrf}`,
        'Referer': 'https://www.pinterest.com/'
      },
      signal: AbortSignal.timeout(9000)
    });

    if (res.ok) {
      const data = await res.json();
      const results = data?.resource_response?.data?.results || [];
      const seen = new Set();

      for (const r of results) {
        if (images.length >= limit) break;
        const origUrl = r.images?.orig?.url;
        const hdUrl = r.images?.['736x']?.url || r.images?.['474x']?.url;
        let chosen = null;

        if (hdUrl && !hdUrl.toLowerCase().includes('.svg') && !hdUrl.toLowerCase().includes('.webp')) {
          chosen = hdUrl;
        } else if (origUrl && !origUrl.toLowerCase().includes('.svg') && !origUrl.toLowerCase().includes('.webp')) {
          chosen = origUrl;
        } else if (origUrl && !origUrl.toLowerCase().includes('.svg')) {
          chosen = origUrl;
        }

        if (chosen && !seen.has(chosen)) {
          seen.add(chosen);
          const rawTitle = (r.title || r.grid_title || '').trim();
          const rawDesc = (r.description || '').trim();
          const pinUrl = r.id ? `https://www.pinterest.com/pin/${r.id}/` : chosen;

          images.push({
            title: rawTitle || `Pin #${images.length + 1}`,
            description: rawDesc ? (rawDesc.length > 80 ? rawDesc.slice(0, 77) + '...' : rawDesc) : `Hasil estetika untuk "${clean}"`,
            url: chosen,
            link: pinUrl
          });
        }
      }
    }
  } catch (err) {
    console.warn('[Pinterest Search Warning]:', err.message);
  }

  // 2. Fallback Wikimedia Commons jika Pinterest kosong
  if (images.length === 0) {
    try {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(clean)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url&format=json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data = await res.json();
        const pages = Object.values(data?.query?.pages || {});
        for (const p of pages) {
          if (images.length >= limit) break;
          const u = p?.imageinfo?.[0]?.url;
          if (!u) continue;
          const cleanUrl = u.split('?')[0].toLowerCase();
          if (!cleanUrl.endsWith('.svg') && (cleanUrl.endsWith('.jpg') || cleanUrl.endsWith('.jpeg') || cleanUrl.endsWith('.png'))) {
            images.push({
              title: p.title ? p.title.replace(/^File:/i, '').trim() : `Gambar #${images.length + 1}`,
              description: `Hasil Wikimedia untuk "${clean}"`,
              url: u,
              link: u
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Wikimedia Search Warning]:', err.message);
    }
  }

  if (images.length === 0) {
    throw new Error(`Gambar untuk "${clean}" tidak ditemukan.`);
  }

  return images;
}

async function searchImage(query) {
  const list = await searchImages(query, 5);
  return list[Math.floor(Math.random() * list.length)].url;
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


/**
 * 12. TRANSKRIP SUARA (Voice Note / Audio to Text via Google Speech API)
 */
async function transcribeAudio(audioBuffer, lang = 'id-ID') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt_'));
  const inPath = path.join(tmpDir, 'in.audio');
  const outPath = path.join(tmpDir, 'out.flac');

  try {
    fs.writeFileSync(inPath, audioBuffer);
    execSync(`ffmpeg -y -i "${inPath}" -ar 16000 -ac 1 "${outPath}"`, { stdio: 'pipe' });
    const flacData = fs.readFileSync(outPath);

    const url = `http://www.google.com/speech-api/v2/recognize?client=chromium&lang=${encodeURIComponent(lang)}&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/x-flac; rate=16000' },
      body: flacData,
      signal: AbortSignal.timeout(20000)
    });

    const raw = await res.text();
    let transcript = '';
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.result && parsed.result[0]?.alternative?.[0]?.transcript) {
          transcript = parsed.result[0].alternative[0].transcript;
        }
      } catch {}
    }
    if (!transcript) throw new Error('Suara tidak terdengar jelas atau terlalu hening');
    return transcript;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 13. EKSTRAK AUDIO DARI VIDEO (.tomp3 / .tovn)
 */
function extractAudioFromVideo(videoBuffer, asVn = false) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract_audio_'));
  const inPath = path.join(tmpDir, 'in.video');
  const outPath = path.join(tmpDir, asVn ? 'out.ogg' : 'out.mp3');

  try {
    fs.writeFileSync(inPath, videoBuffer);
    if (asVn) {
      execSync(`ffmpeg -y -i "${inPath}" -vn -c:a libopus -b:a 64k "${outPath}"`, { stdio: 'pipe' });
    } else {
      execSync(`ffmpeg -y -i "${inPath}" -vn -c:a libmp3lame -q:a 2 "${outPath}"`, { stdio: 'pipe' });
    }
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 14. BACA & EKSTRAK TEKS ARTIKEL/WEB UNTUK DIRINGKAS (.ringkas)
 */
async function fetchAndExtractText(url) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    throw new Error('Link tidak valid. Pastikan diawali dengan http:// atau https://');
  }

  const res = await fetch(cleanUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'id,en-US;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!res.ok) throw new Error(`Gagal membuka link artikel (HTTP ${res.status})`);
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  const cleanText = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanText.length < 50) {
    throw new Error('Halaman web tidak memiliki cukup teks untuk diringkas atau diproteksi');
  }

  return {
    title,
    text: cleanText.slice(0, 4500)
  };
}

/**
 * 15. INSTAGRAM DOWNLOADER (.ig / .igdl / .dl)
 */
const SNAPVIDEO_HOME = 'https://snapvideo.app/en';
const SNAPVIDEO_SEARCH = 'https://snapvideo.app/api/ajaxSearch';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const igRequest = (url, options, body, redirects = 5) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, options || {}, response => {
      const location = response.headers.location;
      if (location && response.statusCode >= 300 && response.statusCode < 400 && redirects > 0) {
        response.resume();
        return resolve(igRequest(new URL(location, url).toString(), options, body, redirects - 1));
      }
      resolve(response);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

const igReadStream = stream => {
  const buffer = [];
  return new Promise((resolve, reject) => {
    stream
      .on('error', reject)
      .on('data', chunk => buffer.push(chunk))
      .on('end', () => resolve(Buffer.concat(buffer)));
  });
};

const igPostForm = (url, data) => {
  const body = querystring.stringify(data);
  return igRequest(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'content-length': Buffer.byteLength(body),
      'origin': 'https://snapvideo.app',
      'referer': SNAPVIDEO_HOME,
      'user-agent': USER_AGENT,
      'x-requested-with': 'XMLHttpRequest'
    }
  }, body, 5);
};

const igDecodeHtml = value =>
  String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");

const igStripTags = value =>
  igDecodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

const igGetTokenPayload = url => {
  const token = String(url || '').match(/[?&]token=([^&]+)/);
  if (!token) return null;
  const parts = token[1].split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '==='.slice((payload.length + 3) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString());
  } catch {
    return null;
  }
};

const igInferMediaType = (url, text) => {
  const payload = igGetTokenPayload(url);
  const filename = payload && payload.filename ? payload.filename : '';
  const sourceUrl = payload && payload.url ? payload.url : '';
  const value = `${url} ${filename} ${sourceUrl} ${text || ''}`.toLowerCase();
  if (/\.(jpg|jpeg|png|webp)(\?|$)/.test(value) || value.includes('photo')) return 'photo';
  if (/\.(mp4|mov|webm)(\?|$)/.test(value) || value.includes('video')) return 'video';
  return 'video';
};

const getSnapVideoConfig = () =>
  igRequest(SNAPVIDEO_HOME, { headers: { 'user-agent': USER_AGENT } })
    .then(igReadStream)
    .then(buffer => buffer.toString())
    .then(html => {
      const exp = html.match(/k_exp="([^"]+)"/);
      const token = html.match(/k_token="([^"]+)"/);
      if (!exp || !token) throw new Error('Gagal membaca token downloader Instagram');
      return { exp: exp[1], token: token[1] };
    });

async function getInstagramMedia(url) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) throw new Error('URL Instagram wajib diisi.');

  const config = await getSnapVideoConfig();
  const resp = await igPostForm(SNAPVIDEO_SEARCH, {
    k_exp: config.exp,
    k_token: config.token,
    q: cleanUrl,
    t: 'media',
    lang: 'en',
    v: 'v2'
  });

  const buffer = await igReadStream(resp);
  let result;
  try {
    result = JSON.parse(buffer.toString());
  } catch (e) {
    throw new Error('Gagal memproses respon dari server downloader Instagram');
  }

  if (result.status !== 'ok' || !result.data) {
    throw new Error(result.mess || 'Gagal mengambil media Instagram. Pastikan akun atau postingan bersifat publik.');
  }

  const html = result.data;
  const candidates = [];
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html))) {
    const rawHref = igDecodeHtml(match[1]);
    const text = igStripTags(match[2]);
    if (!/^https?:\/\//i.test(rawHref)) continue;
    if (!/(download|dl|cdn|instagram|fbcdn|snapvideo|i-1-cdn)/i.test(rawHref + text)) continue;
    const type = igInferMediaType(rawHref, text);
    candidates.push({ url: rawHref, type, text });
  }

  const seen = new Set();
  const mediaList = [];
  for (const item of candidates) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      mediaList.push(item);
    }
  }

  if (!mediaList.length) {
    throw new Error('Media tidak ditemukan. Pastikan link postingan/Reel publik.');
  }

  return mediaList;
}

module.exports = {
  makeQcSticker,
  getInstagramMedia,
  makeSmemeSticker,
  makeTtpSticker,
  makeAttpSticker,
  getGoogleTts,
  applyAudioEffect,
  getGempaBmkg,
  getWebScreenshot,
  getTikTokVideo,
  searchImage,
  searchImages,
  getRandomTebakKata,
  transcribeAudio,
  extractAudioFromVideo,
  fetchAndExtractText
};
