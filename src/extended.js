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
  if (typeof text === 'object' && text !== null) {
    const opts = text;
    text = opts.text;
    name = opts.name || name;
    avatarBuffer = opts.avatarBuffer || avatarBuffer;
    if (!avatarBuffer && opts.avatarUrl) {
      try {
        const axios = require('axios');
        const res = await axios.get(opts.avatarUrl, { responseType: 'arraybuffer', timeout: 8000 });
        if (res.status === 200 && res.data) avatarBuffer = Buffer.from(res.data);
      } catch (_) {}
    }
  }
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

    const apiKey = process.env.GOOGLE_SPEECH_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!apiKey) {
      throw new Error('Fitur transkrip suara membutuhkan GOOGLE_SPEECH_API_KEY di environment variables');
    }
    const url = `http://www.google.com/speech-api/v2/recognize?client=chromium&lang=${encodeURIComponent(lang)}&key=${encodeURIComponent(apiKey)}`;
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
    const cleanMsg = result.mess ? igStripTags(result.mess) : '';
    throw new Error(cleanMsg || 'Gagal mengambil media Instagram. Pastikan akun atau postingan bersifat publik.');
  }

  const html = result.data;
  const candidates = [];
  const linkRegex = /<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html))) {
    const preAttr = match[1] || '';
    const rawHref = igDecodeHtml(match[2]);
    const postAttr = match[3] || '';
    const text = igStripTags(match[4]);
    const allAttr = `${preAttr} ${postAttr} ${text}`.toLowerCase();

    if (!/^https?:\/\//i.test(rawHref)) continue;
    if (!/(download|dl|cdn|instagram|fbcdn|snapvideo|i-1-cdn)/i.test(rawHref + text)) continue;

    // Deteksi apakah tombol ini hanya download thumbnail / cover video
    const isThumbnail = /thumb|thumbnail|dl-thumb/i.test(allAttr);
    const isExplicitVideo = /video|mp4/i.test(allAttr);
    let type = igInferMediaType(rawHref, text);
    if (isExplicitVideo) type = 'video';
    if (isThumbnail) type = 'photo';

    candidates.push({ 
      url: rawHref, 
      type, 
      text, 
      isThumbnail 
    });
  }

  const seen = new Set();
  const uniqueCandidates = [];
  for (const item of candidates) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      uniqueCandidates.push(item);
    }
  }

  // Pisahkan video asli, foto asli, dan thumbnail
  const videos = uniqueCandidates.filter(c => c.type === 'video' && !c.isThumbnail);
  const photos = uniqueCandidates.filter(c => c.type === 'photo' && !c.isThumbnail);
  const thumbs = uniqueCandidates.filter(c => c.isThumbnail);

  let mediaList = [];
  if (videos.length > 0) {
    // Utamakan video asli
    mediaList = [...videos];
    // Jika ada foto non-thumbnail (misal postingan carousel campuran foto + video)
    if (photos.length > 0) {
      mediaList = mediaList.concat(photos);
    }
  } else if (photos.length > 0) {
    mediaList = photos;
  } else if (thumbs.length > 0) {
    mediaList = thumbs;
  } else {
    mediaList = uniqueCandidates;
  }

  if (!mediaList.length) {
    throw new Error('Media tidak ditemukan. Pastikan link postingan/Reel publik.');
  }

  return mediaList;
}


/**
 * 16. FAKE TWEET GENERATOR (.tweet)
 * Membuat mockup postingan Twitter / X dark mode asli lengkap dengan verified badge, avatar bulat, dan metrik interaksi
 */
async function makeFakeTweet({
  name = 'User',
  username = 'user',
  text = '',
  avatarBuffer = null,
  retweets = null,
  quotes = null,
  likes = null,
  bookmarks = null
}) {
  const cleanName = String(name || 'User').trim().slice(0, 30);
  const cleanUsername = String(username || 'user').trim().replace(/^@/, '').slice(0, 25);
  const lines = wrapText(text, 44, 10);

  const cardWidth = 720;
  const padding = 32;
  const avatarSize = 60;

  const headerHeight = avatarSize;
  const textLineHeight = 32;
  const textBlockHeight = lines.length * textLineHeight;
  const footerHeight = 150;

  const cardHeight = padding + headerHeight + 20 + textBlockHeight + 20 + footerHeight + padding;

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
    } catch (_) {
      circularAvatarBuffer = null;
    }
  }

  const avatarX = padding;
  const avatarY = padding;
  const nameX = avatarX + avatarSize + 16;
  const nameY = avatarY + 24;
  const handleY = nameY + 22;

  const textStartY = avatarY + avatarSize + 28;
  const textTspans = lines
    .map((line, idx) => `<tspan x="${padding}" dy="${idx === 0 ? 0 : textLineHeight}">${escapeXml(line)}</tspan>`)
    .join('\n');

  const timeY = textStartY + textBlockHeight + 26;
  const hr1Y = timeY + 18;
  const statsY = hr1Y + 28;
  const hr2Y = statsY + 18;
  const iconsY = hr2Y + 22;

  const now = new Date();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateStr = `${displayHours}:${minutes} ${ampm} · ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()} · Twitter for iPhone`;

  const fallbackInitials = (cleanName[0] || 'U').toUpperCase();

  const formatNum = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  };
  const retweetsStr = retweets || formatNum(Math.floor(Math.random() * 25000) + 1200);
  const quotesStr = quotes || formatNum(Math.floor(Math.random() * 4500) + 320);
  const likesStr = likes || formatNum(Math.floor(Math.random() * 95000) + 5400);
  const bookmarksStr = bookmarks || formatNum(Math.floor(Math.random() * 12000) + 850);

  const svg = `
  <svg width="${cardWidth}" height="${cardHeight}" viewBox="0 0 ${cardWidth} ${cardHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${cardWidth}" height="${cardHeight}" rx="20" ry="20" fill="#000000" stroke="#2f3336" stroke-width="1.5"/>

    ${circularAvatarBuffer ? '' : `
      <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2}" fill="#1d9bf0"/>
      <text x="${avatarX + avatarSize / 2}" y="${avatarY + avatarSize / 2 + 8}" fill="#ffffff" font-size="24" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle">${escapeXml(fallbackInitials)}</text>
    `}

    <text x="${nameX}" y="${nameY}" fill="#e7e9ea" font-size="20" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">${escapeXml(cleanName)}</text>

    <!-- Twitter Verified Badge SVG -->
    <g transform="translate(${nameX + Math.min(230, cleanName.length * 11 + 6)}, ${nameY - 17})">
      <path fill="#1d9bf0" d="M19.39 10.22c.31-.93.13-1.93-.54-2.61s-1.68-.85-2.61-.54c-.44-.88-1.28-1.46-2.24-1.46s-1.79.59-2.23 1.46c-.94-.31-1.94-.14-2.62.54s-.84 1.68-.53 2.61c-.88.44-1.47 1.28-1.47 2.24s.59 1.79 1.47 2.23c-.31.94-.14 1.94.53 2.62s1.68.84 2.62.53c.44.88 1.28 1.47 2.23 1.47s1.8-.59 2.24-1.47c.93.31 1.93.13 2.61-.53s.85-1.68.54-2.62c.88-.44 1.46-1.28 1.46-2.23s-.58-1.8-1.46-2.24zm-7.81 5.34l-2.9-2.9 1.21-1.21 1.69 1.69 4.12-4.12 1.21 1.21-5.33 5.33z"/>
    </g>

    <text x="${nameX}" y="${handleY}" fill="#71767b" font-size="16" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">@${escapeXml(cleanUsername)}</text>

    <!-- X Logo Top Right -->
    <g transform="translate(${cardWidth - padding - 28}, ${avatarY + 6}) scale(1.2)">
      <path fill="#71767b" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </g>

    <!-- Tweet Body Text -->
    <text x="${padding}" y="${textStartY}" fill="#e7e9ea" font-size="22" font-weight="400" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">
      ${textTspans}
    </text>

    <!-- Timestamp -->
    <text x="${padding}" y="${timeY}" fill="#71767b" font-size="15" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">${escapeXml(dateStr)}</text>

    <!-- Divider 1 -->
    <line x1="${padding}" y1="${hr1Y}" x2="${cardWidth - padding}" y2="${hr1Y}" stroke="#2f3336" stroke-width="1"/>

    <!-- Stats Row -->
    <text x="${padding}" y="${statsY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="15">
      <tspan fill="#e7e9ea" font-weight="700">${escapeXml(retweetsStr)}</tspan> <tspan fill="#71767b">Retweets</tspan>
      <tspan dx="18" fill="#e7e9ea" font-weight="700">${escapeXml(quotesStr)}</tspan> <tspan fill="#71767b">Quotes</tspan>
      <tspan dx="18" fill="#e7e9ea" font-weight="700">${escapeXml(likesStr)}</tspan> <tspan fill="#71767b">Likes</tspan>
      <tspan dx="18" fill="#e7e9ea" font-weight="700">${escapeXml(bookmarksStr)}</tspan> <tspan fill="#71767b">Bookmarks</tspan>
    </text>

    <!-- Divider 2 -->
    <line x1="${padding}" y1="${hr2Y}" x2="${cardWidth - padding}" y2="${hr2Y}" stroke="#2f3336" stroke-width="1"/>

    <!-- Action Icons (Reply, Retweet, Like, Bookmark, Share) -->
    <g transform="translate(${padding + 30}, ${iconsY})" fill="#71767b">
      <path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-1.102.61.405 1.18c.421 1.23.111 2.59-.801 3.5-1.01 1.01-2.47 1.22-3.72.53l-4.52-2.49c-.482-.27-.923-.42-1.385-.42-2.825 0-5.081-2.25-5.081-5.08v-4.87z" transform="scale(0.8)"/>
    </g>
    <g transform="translate(${padding + 180}, ${iconsY})" fill="#71767b">
      <path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.895 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 20.12l-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.895-2-2-2H11V4h2.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14z" transform="scale(0.8)"/>
    </g>
    <g transform="translate(${padding + 330}, ${iconsY})" fill="#f91880">
      <path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-2.415.11-4.304 2.12-4.304 4.58 0 1.28.53 2.4 1.401 3.24L12 21l7.6-7.68c.87-.84 1.4-1.96 1.4-3.24 0-2.46-1.89-4.47-4.303-4.58z" transform="scale(0.8)"/>
    </g>
    <g transform="translate(${padding + 480}, ${iconsY})" fill="#71767b">
      <path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v16.88c0 .85-.92 1.38-1.66.95L12 18.25l-6.34 4.08c-.74.43-1.66-.1-1.66-.95V4.5z" transform="scale(0.8)"/>
    </g>
    <g transform="translate(${cardWidth - padding - 40}, ${iconsY})" fill="#71767b">
      <path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41L7.71 9.71 6.3 8.29 12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21.01 3 19.9 3 18.51V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5V15h2.02z" transform="scale(0.8)"/>
    </g>
  </svg>
  `.trim();

  let img = sharp(Buffer.from(svg));
  if (circularAvatarBuffer) {
    img = img.composite([{ input: circularAvatarBuffer, left: avatarX, top: avatarY }]);
  }
  return await img.png().toBuffer();
}

/**
 * 17. AESTHETIC DARK QUOTE GENERATOR (.quote)
 * Membuat poster kata bijak estetik bernuansa gelap sinematik dengan tanda kutip besar, avatar berbingkai neon, dan signature
 */
async function makeAestheticQuote({
  name = 'Seseorang',
  username = 'user',
  text = 'Kutipan kata bijak...',
  avatarBuffer = null,
  year = '2026'
}) {
  const cleanName = String(name || 'Seseorang').trim().slice(0, 28);
  const cleanUsername = String(username || 'user').trim().replace(/^@/, '').slice(0, 24);
  const lines = wrapText(text, 34, 7);

  const cardWidth = 960;
  const cardHeight = 540;

  const avatarSize = 120;
  const avatarX = 70;
  const avatarY = 160;

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
    } catch (_) {
      circularAvatarBuffer = null;
    }
  }

  const quoteX = 260;
  const quoteLineHeight = 38;
  const totalTextHeight = lines.length * quoteLineHeight;
  const quoteStartY = Math.max(150, Math.round((cardHeight - totalTextHeight) / 2) - 10);

  const textTspans = lines
    .map((line, idx) => `<tspan x="${quoteX}" dy="${idx === 0 ? 0 : quoteLineHeight}">${escapeXml(line)}</tspan>`)
    .join('\n');

  const authorY = quoteStartY + totalTextHeight + 42;
  const fallbackInitial = (cleanName[0] || 'U').toUpperCase();

  const svg = `
  <svg width="${cardWidth}" height="${cardHeight}" viewBox="0 0 ${cardWidth} ${cardHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#090a0f"/>
        <stop offset="50%" stop-color="#121622"/>
        <stop offset="100%" stop-color="#1b2030"/>
      </linearGradient>
      <linearGradient id="ring" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="100%" stop-color="#818cf8"/>
      </linearGradient>
      <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="100%" stop-color="#a855f7"/>
      </linearGradient>
      <filter id="glow" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000000" flood-opacity="0.6"/>
      </filter>
    </defs>

    <rect width="${cardWidth}" height="${cardHeight}" fill="url(#bg)"/>
    <rect x="24" y="24" width="${cardWidth - 48}" height="${cardHeight - 48}" rx="20" ry="20" fill="none" stroke="#2d3748" stroke-width="1.2" opacity="0.6"/>

    <text x="235" y="230" fill="#38bdf8" font-size="220" font-family="Georgia, serif" opacity="0.08" font-weight="700">“</text>

    <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2 + 5}" fill="none" stroke="url(#ring)" stroke-width="3" filter="url(#glow)"/>

    ${circularAvatarBuffer ? '' : `
      <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2}" fill="#1e293b"/>
      <text x="${avatarX + avatarSize / 2}" y="${avatarY + avatarSize / 2 + 18}" fill="#38bdf8" font-size="52" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle">${escapeXml(fallbackInitial)}</text>
    `}

    <text x="${avatarX + avatarSize / 2}" y="${avatarY + avatarSize + 34}" fill="#f8fafc" font-size="18" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle">${escapeXml(cleanName)}</text>
    <text x="${avatarX + avatarSize / 2}" y="${avatarY + avatarSize + 56}" fill="#94a3b8" font-size="13" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle">@${escapeXml(cleanUsername)}</text>

    <rect x="${avatarX + avatarSize / 2 - 40}" y="${avatarY + avatarSize + 68}" width="80" height="20" rx="10" ry="10" fill="#1e293b" stroke="#334155" stroke-width="1"/>
    <text x="${avatarX + avatarSize / 2}" y="${avatarY + avatarSize + 82}" fill="#38bdf8" font-size="10" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle">WORDS OF WISDOM</text>

    <line x1="225" y1="120" x2="225" y2="${cardHeight - 120}" stroke="#334155" stroke-width="1.5" opacity="0.4"/>

    <text x="${quoteX}" y="${quoteStartY}" fill="#f1f5f9" font-size="28" font-style="italic" font-family="Georgia, 'Times New Roman', serif" letter-spacing="0.5">
      ${textTspans}
    </text>

    <line x1="${quoteX}" y1="${authorY - 14}" x2="${quoteX + 60}" y2="${authorY - 14}" stroke="url(#accent)" stroke-width="3" stroke-linecap="round"/>
    <text x="${quoteX + 75}" y="${authorY - 9}" fill="#38bdf8" font-size="18" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">— ${escapeXml(cleanName)}, <tspan fill="#64748b" font-weight="400">${escapeXml(year)}</tspan></text>

    <text x="${cardWidth - 50}" y="${cardHeight - 44}" fill="#475569" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="end" letter-spacing="1">TUFFBOT QUOTES</text>
  </svg>
  `.trim();

  let img = sharp(Buffer.from(svg));
  if (circularAvatarBuffer) {
    img = img.composite([{ input: circularAvatarBuffer, left: avatarX, top: avatarY }]);
  }
  return await img.png().toBuffer();
}

module.exports = {
  makeFakeTweet,
  makeAestheticQuote,
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
