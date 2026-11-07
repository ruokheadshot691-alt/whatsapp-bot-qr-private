const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

/**
 * Memecah teks menjadi baris-baris berukuran pas untuk canvas 512x512
 */
function wrapBratText(text, maxCharsPerLine = 12) {
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Menghitung ukuran font dinamis agar teks tetap seimbang dan berada di tengah
 */
function calculateBratFontSize(lines) {
  const lineCount = lines.length;
  const maxLen = Math.max(...lines.map((l) => l.length), 0);

  if (lineCount <= 1) {
    return maxLen <= 5 ? 74 : maxLen <= 9 ? 58 : 46;
  }
  if (lineCount <= 2) {
    return maxLen <= 8 ? 52 : 44;
  }
  if (lineCount <= 4) {
    return 38;
  }
  if (lineCount <= 6) {
    return 30;
  }
  return 24;
}

/**
 * Membuat stiker Brat biasa (statis)
 * Background putih, teks hitam lowercase, efek blur khas album Brat
 */
async function makeBratSticker(text, bgColor = 'white') {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Teks untuk stiker Brat tidak boleh kosong.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brat_'));
  const txtPath = path.join(tmpDir, 'brat.txt');
  const outPath = path.join(tmpDir, 'brat.webp');

  try {
    const lines = wrapBratText(clean, 12);
    const fontSize = calculateBratFontSize(lines);
    fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');

    // ffmpeg menggambar teks dari file teks, lalu menerapkan boxblur khas Brat
    const cmd = `ffmpeg -y -f lavfi -i color=c=${bgColor}:s=512x512 -vf "drawtext=textfile='${txtPath}':fontsize=${fontSize}:fontcolor=black:line_spacing=6:x=(w-text_w)/2:y=(h-text_h)/2,boxblur=1:1" -vframes 1 -vcodec libwebp -lossless 0 -q:v 75 "${outPath}"`;
    execSync(cmd, { stdio: 'pipe' });

    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Membuat stiker video Brat (animasi kata demi kata)
 * Kata muncul satu per satu hingga selesai membentuk kalimat utuh
 */
async function makeBratVideoSticker(text, bgColor = 'white') {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Teks untuk stiker video Brat tidak boleh kosong.');

  const words = clean.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error('Teks tidak valid.');

  // Batasi maksimal 20 kata agar proses render cepat dan ukuran file tetap ringan di bawah 200KB
  const limitedWords = words.slice(0, 20);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bratvid_'));
  const outWebp = path.join(tmpDir, 'output.webp');

  try {
    // Generate urutan kata yang muncul bertahap
    const frames = [];
    for (let i = 1; i <= limitedWords.length; i++) {
      frames.push(limitedWords.slice(0, i).join(' '));
    }
    // Tahan kalimat utuh selama 3 frame ekstra di akhir (~1 detik) agar sempat dibaca
    frames.push(limitedWords.join(' '));
    frames.push(limitedWords.join(' '));
    frames.push(limitedWords.join(' '));

    const finalLines = wrapBratText(limitedWords.join(' '), 12);
    const fontSize = calculateBratFontSize(finalLines);

    for (let i = 0; i < frames.length; i++) {
      const wrapped = wrapBratText(frames[i], 12);
      const txtPath = path.join(tmpDir, `text_${i}.txt`);
      fs.writeFileSync(txtPath, wrapped.join('\n'), 'utf8');

      const pngPath = path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.png`);
      const cmd = `ffmpeg -y -f lavfi -i color=c=${bgColor}:s=512x512 -vf "drawtext=textfile='${txtPath}':fontsize=${fontSize}:fontcolor=black:line_spacing=6:x=(w-text_w)/2:y=(h-text_h)/2,boxblur=1:1" -vframes 1 "${pngPath}"`;
      execSync(cmd, { stdio: 'pipe' });
    }

    // Gabungkan menjadi animated WebP dengan framerate 2.5 fps (~0.4 detik tiap kata baru muncul)
    const animCmd = `ffmpeg -y -framerate 2.5 -i "${tmpDir}/frame_%03d.png" -vcodec libwebp -lossless 0 -compression_level 4 -q:v 70 -loop 0 -an "${outWebp}"`;
    execSync(animCmd, { stdio: 'pipe' });

    return fs.readFileSync(outWebp);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  makeBratSticker,
  makeBratVideoSticker
};
