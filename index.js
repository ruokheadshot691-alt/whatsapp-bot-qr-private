require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  EmbedBuilder, 
  AttachmentBuilder, 
  ActivityType,
  PermissionsBitField
} = require('discord.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');

// Import modular features
const { 
  askAI, 
  translateText, 
  getWikiSummary, 
  getSurah, 
  getJadwalSholat, 
  getWeather, 
  shortenUrl, 
  generateQrBuffer 
} = require('./src/tools');

const { makeSticker, stickerToImage } = require('./src/sticker');
const { upscaleImage } = require('./src/hd');
const { makeBratSticker, makeBratVideoSticker } = require('./src/brat');
const {
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
  searchImages,
  getRandomTebakKata,
  getInstagramMedia,
  fetchAndExtractText,
  extractAudioFromVideo,
  transcribeAudio
} = require('./src/extended');

// Pastikan direktori data ada
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Penyimpanan persona pengguna (data/ai-settings.json)
const aiSettingsFile = path.join(dataDir, 'ai-settings.json');
function loadAiSettings() {
  try {
    if (fs.existsSync(aiSettingsFile)) {
      return JSON.parse(fs.readFileSync(aiSettingsFile, 'utf8'));
    }
  } catch (_) {}
  return { personas: {} };
}

function saveAiSettings(settings) {
  try {
    fs.writeFileSync(aiSettingsFile, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal menyimpan ai-settings:', err.message);
  }
}

// Memory percakapan AI per user (maks 10 pesan, kedaluwarsa 30 menit)
const aiHistories = new Map();
const AI_HISTORY_LIMIT = 10;
const AI_HISTORY_TTL = 30 * 60 * 1000;

function getAiHistory(userId) {
  const item = aiHistories.get(userId);
  if (!item) return [];
  if (Date.now() - item.lastActive > AI_HISTORY_TTL) {
    aiHistories.delete(userId);
    return [];
  }
  return item.messages;
}

function appendAiHistory(userId, role, content) {
  let item = aiHistories.get(userId);
  if (!item || Date.now() - item.lastActive > AI_HISTORY_TTL) {
    item = { messages: [], lastActive: Date.now() };
    aiHistories.set(userId, item);
  }
  item.messages.push({ role, content });
  if (item.messages.length > AI_HISTORY_LIMIT) {
    item.messages = item.messages.slice(-AI_HISTORY_LIMIT);
  }
  item.lastActive = Date.now();
}

function clearAiHistory(userId) {
  aiHistories.delete(userId);
}

// Sesi game tebak kata per channel
const activeTebakKata = new Map();

// Cooldown command per user
const userCooldowns = new Map();
const COOLDOWN_MS = 2000;

// Setup Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Helper: Ekstrak buffer media dari attachment atau pesan balasan
async function getMediaBuffer(message, args = []) {
  // 1. Attachment pada pesan itu sendiri
  if (message.attachments && message.attachments.size > 0) {
    const att = message.attachments.first();
    const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 30000 });
    return { buffer: Buffer.from(res.data), contentType: att.contentType, name: att.name };
  }

  // 2. Attachment pada pesan yang di-reply
  if (message.reference && message.reference.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg && refMsg.attachments && refMsg.attachments.size > 0) {
        const att = refMsg.attachments.first();
        const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 30000 });
        return { buffer: Buffer.from(res.data), contentType: att.contentType, name: att.name };
      }
    } catch (_) {}
  }

  // 3. Link gambar langsung di argumen perintah
  if (args[0] && /^https?:\/\//i.test(args[0])) {
    try {
      const res = await axios.get(args[0], { responseType: 'arraybuffer', timeout: 30000 });
      return { buffer: Buffer.from(res.data), contentType: res.headers['content-type'], name: 'downloaded.jpg' };
    } catch (_) {}
  }

  return null;
}

// Helper: Dapatkan teks konteks (dari argumen atau balasan pesan)
async function getContextText(message, args = []) {
  if (args.length > 0) return args.join(' ');
  if (message.reference && message.reference.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg && refMsg.content) return refMsg.content;
    } catch (_) {}
  }
  return '';
}

// Format durasi aktif bot
function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d > 0 ? `${d}h ` : ''}${h > 0 ? `${h}j ` : ''}${m}m ${s}d`;
}

// Core Command Handler: Dapat dipanggil dari Discord chat maupun console CLI
async function handleCommand({ message, command, args, rawText }) {
  const prefix = config.prefix || '.';
  const userId = message.author ? message.author.id : 'console-user';
  const authorName = message.author ? (message.author.displayName || message.author.username) : 'Console';
  const avatarUrl = message.author && message.author.displayAvatarURL ? message.author.displayAvatarURL({ extension: 'png' }) : 'https://cdn.discordapp.com/embed/avatars/0.png';

  let replyTextOutput = null;

  switch (command) {
    case 'menu':
    case 'help': {
      const embed = new EmbedBuilder()
        .setColor(config.embedColor || 0x5865F2)
        .setTitle(`📖 Menu & Daftar Fitur Lengkap ${config.botName}`)
        .setDescription(`Halo **${authorName}**! Gunakan prefix \`${prefix}\` sebelum setiap perintah.`)
        .addFields(
          {
            name: '🤖 AI & Karakter Persona',
            value: [
              `\`${prefix}ai <tanya>\` - Tanya AI pintar dengan memori percakapan`,
              `\`${prefix}ringkas <link/teks>\` - Ringkas artikel web atau teks panjang`,
              `\`${prefix}persona <watak>\` - Atur custom persona/sifat khusus AI`,
              `\`${prefix}mypersona\` - Cek persona yang sedang aktif`,
              `\`${prefix}resetai\` - Bersihkan memori chat AI`
            ].join('\n')
          },
          {
            name: '🎨 Stiker & Olah Media',
            value: [
              `\`${prefix}s\` - Ubah gambar (kirim/reply) jadi stiker WebP`,
              `\`${prefix}toimg\` - Ubah stiker kembali jadi gambar foto`,
              `\`${prefix}hd\` - Tingkatkan kualitas foto ke HD (AI Upscaler)`,
              `\`${prefix}brat <teks>\` - Stiker aesthetic teks Brat putih`,
              `\`${prefix}bratvid <teks>\` - Stiker video/GIF animasi kata Brat`,
              `\`${prefix}qc <teks>\` - Stiker Fake Chat gelembung WhatsApp`,
              `\`${prefix}smeme <atas|bawah>\` - Buat stiker meme dari gambar`,
              `\`${prefix}ttp <teks>\` / \`${prefix}attp <teks>\` - Stiker teks neon & rainbow`
            ].join('\n')
          },
          {
            name: '📥 Downloader & Pencarian',
            value: [
              `\`${prefix}dl <link>\` - Smart Auto-Downloader (TikTok & IG)`,
              `\`${prefix}ig <link>\` - Unduh Reels/Video/Foto Instagram`,
              `\`${prefix}tiktok <link>\` - Unduh video TikTok tanpa watermark`,
              `\`${prefix}pin <query>\` - Cari gambar di Pinterest`,
              `\`${prefix}img <query>\` - Cari gambar di Google`,
              `\`${prefix}ssweb <url>\` - Tangkap layar website jadi gambar`
            ].join('\n')
          },
          {
            name: '🎙️ Audio & Voice Tools',
            value: [
              `\`${prefix}tts <teks>\` - Ubah teks menjadi suara Google (MP3)`,
              `\`${prefix}tomp3\` - Reply video untuk diekstrak jadi audio MP3`,
              `\`${prefix}transkrip\` - Reply pesan suara/audio untuk diubah ke teks`,
              `\`${prefix}bass\`, \`${prefix}slow\`, \`${prefix}robot\`, \`${prefix}chipmunk\` - Efek audio`
            ].join('\n')
          },
          {
            name: '🛠️ Utilitas & Rahasia',
            value: [
              `\`${prefix}tr <kode> <teks>\` - Terjemahan bahasa (.tr en halo)`,
              `\`${prefix}menfess <@user/ID> <pesan>\` - Kirim pesan rahasia anonim`,
              `\`${prefix}cuaca <kota>\` - Info ramalan cuaca realtime`,
              `\`${prefix}sholat <kota>\` - Jadwal sholat harian akurat`,
              `\`${prefix}surah <1-114>\` - Info & ayat Al-Qur'an`,
              `\`${prefix}gempa\` - Data gempa bumi BMKG terkini + peta`,
              `\`${prefix}wiki <topik>\` - Ringkasan artikel Wikipedia`,
              `\`${prefix}calc <angka>\` - Kalkulator matematika`,
              `\`${prefix}qr <teks>\` - Buat QR Code gambar`,
              `\`${prefix}short <link>\` - Perpendek link TinyURL`
            ].join('\n')
          },
          {
            name: '🛡️ Moderasi & Kontrol Server',
            value: [
              `\`${prefix}kick @user [alasan]\` - Tendang member dari server`,
              `\`${prefix}ban @user [alasan]\` - Blokir member permanen`,
              `\`${prefix}unban <User_ID>\` - Buka blokir member`,
              `\`${prefix}mute @user [menit]\` - Timeout / bisukan member`,
              `\`${prefix}unmute @user\` - Buka kembali bisukan member`,
              `\`${prefix}clearchat [jumlah]\` - Hapus pesan massal di channel`,
              `\`${prefix}slowmode <detik>\` - Atur batas kecepatan chat`,
              `\`${prefix}tagall <pesan>\` - Mention @everyone di server`,
              `\`${prefix}serverinfo\` - Statistik lengkap server`,
              `\`${prefix}userinfo [@user]\` - Cek profil & tanggal gabung member`,
              `\`${prefix}setname <nama>\` - Ganti nickname bot`,
              `\`${prefix}setdesc <topik>\` - Ganti topik channel`
            ].join('\n')
          },
          {
            name: '🎲 Mini Games & Hiburan',
            value: [
              `\`${prefix}tebakkata\` - Kuis tebak kata berhadiah (60 detik)`,
              `\`${prefix}dadu\` - Lempar dadu acak 1-6`,
              `\`${prefix}koin\` - Lempar koin (Gambar / Angka)`,
              `\`${prefix}apakah <tanya>\` - Jawaban acak bot`,
              `\`${prefix}rate <hal>\` - Nilai rating sesuatu (0-100%)`,
              `\`${prefix}siapakah <pertanyaan>\` - Pilih member acak server`
            ].join('\n')
          },
          {
            name: '⚙️ Info Bot',
            value: `\`${prefix}ping\` | \`${prefix}runtime\` | \`${prefix}owner\``
          }
        )
        .setFooter({ text: `${config.botName} • Semua Fitur Telah Dikembalikan Lengkap`, iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = 'Menu berhasil ditampilkan di Discord.';
      break;
    }

    case 'ping': {
      const pingMs = Math.round(client.ws.ping);
      const text = `🏓 **Pong!**\nLatency Bot: \`${Date.now() - message.createdTimestamp}ms\` | Discord API: \`${pingMs}ms\``;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'runtime':
    case 'uptime': {
      const text = `⏱️ **Bot Runtime / Uptime:** ${formatUptime(process.uptime())}`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'owner': {
      const text = `👑 **Owner Bot:** <@${config.ownerId || client.application?.owner?.id || 'Fatih'}>`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    // --- AI & PERSONA ---
    case 'ai':
    case 'tanya':
    case 'ask': {
      const prompt = await getContextText(message, args);
      if (!prompt) {
        const text = `⚠️ Masukkan pertanyaan! Contoh: \`${prefix}ai Siapa penemu komputer?\` atau reply pesan teks.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      if (message.channel && message.channel.sendTyping) {
        message.channel.sendTyping().catch(() => {});
      }

      const settings = loadAiSettings();
      const userPersona = settings.personas[userId] || '';
      const history = getAiHistory(userId);

      try {
        const answer = await askAI(prompt, userId, userPersona, history);
        appendAiHistory(userId, 'user', prompt);
        appendAiHistory(userId, 'assistant', answer);

        // Discord batasan 2000 karakter per pesan
        if (answer.length <= 2000) {
          await message.reply({ content: answer });
        } else {
          // Bagi pesan jika panjang
          for (let i = 0; i < answer.length; i += 1900) {
            await message.channel.send(answer.substring(i, i + 1900));
          }
        }
        replyTextOutput = answer;
      } catch (err) {
        const errText = `❌ Gagal mendapatkan jawaban AI: ${err.message}`;
        await message.reply({ content: errText });
        replyTextOutput = errText;
      }
      break;
    }

    case 'persona':
    case 'setpersona': {
      const prompt = args.join(' ').trim();
      const settings = loadAiSettings();

      if (!prompt) {
        const current = settings.personas[userId];
        const text = current 
          ? `🎭 **Persona aktif kamu saat ini:**\n"${current}"\n\nUntuk menghapus/reset, ketik: \`${prefix}persona reset\`` 
          : `ℹ️ Kamu belum mengatur custom persona.\nContoh: \`${prefix}persona Kamu adalah teman akrab yang santai dan gaul.\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      if (prompt.toLowerCase() === 'reset' || prompt.toLowerCase() === 'hapus') {
        delete settings.personas[userId];
        saveAiSettings(settings);
        clearAiHistory(userId);
        const text = '✅ Persona custom kamu telah direset ke default.';
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      settings.personas[userId] = prompt;
      saveAiSettings(settings);
      clearAiHistory(userId);
      const text = `✅ **Persona AI berhasil diperbarui!**\nPrompt: "${prompt}"\nRiwayat chat telah di-refresh untuk persona baru.`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'mypersona': {
      const settings = loadAiSettings();
      const current = settings.personas[userId];
      const text = current 
        ? `🎭 **Persona aktif kamu:** "${current}"` 
        : 'ℹ️ Kamu saat ini memakai persona standar.';
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'resetai':
    case 'cleari': {
      clearAiHistory(userId);
      const text = '🧹 Riwayat memori percakapan AI kamu berhasil dibersihkan.';
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    // --- STIKER & OLAH MEDIA ---
    case 's':
    case 'sticker': {
      const media = await getMediaBuffer(message, args);
      if (!media) {
        const text = `⚠️ Kirim gambar dengan caption \`${prefix}s\` atau reply gambar yang ada.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      try {
        const stickerBuf = await makeSticker(media.buffer);
        const attachment = new AttachmentBuilder(stickerBuf, { name: 'sticker.webp' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Stiker WebP Terkirim]';
      } catch (err) {
        const text = `❌ Gagal membuat stiker: ${err.message}`;
        await message.reply({ content: text });
        replyTextOutput = text;
      }
      break;
    }

    case 'toimg': {
      const media = await getMediaBuffer(message, args);
      if (!media) {
        const text = `⚠️ Reply stiker WebP dengan caption \`${prefix}toimg\`.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const imgBuf = await stickerToImage(media.buffer);
        const attachment = new AttachmentBuilder(imgBuf, { name: 'converted.jpg' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Gambar JPEG Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal: ${err.message}` });
      }
      break;
    }

    case 'hd':
    case 'remini': {
      const media = await getMediaBuffer(message, args);
      if (!media) {
        const text = `⚠️ Kirim/reply foto dengan \`${prefix}hd\` untuk meningkatkan kualitas gambar.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      await message.channel.send('⏳ Memproses penjernihan foto (AI Upscaling)...');
      try {
        const hdBuf = await upscaleImage(media.buffer);
        const attachment = new AttachmentBuilder(hdBuf, { name: 'hd.jpg' });
        await message.reply({ content: '✅ Foto berhasil di-HD kan:', files: [attachment] });
        replyTextOutput = '[Foto HD Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal menjernihkan foto: ${err.message}` });
      }
      break;
    }

    case 'brat': {
      const textInput = await getContextText(message, args);
      if (!textInput) {
        const text = `⚠️ Masukkan teks! Contoh: \`${prefix}brat aku sayang kamu\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const bratBuf = await makeBratSticker(textInput);
        const attachment = new AttachmentBuilder(bratBuf, { name: 'brat.webp' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Brat Sticker Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal membuat Brat: ${err.message}` });
      }
      break;
    }

    case 'bratvid':
    case 'bratvideo':
    case 'bratv': {
      const textInput = await getContextText(message, args);
      if (!textInput) {
        const text = `⚠️ Masukkan teks! Contoh: \`${prefix}bratvid teks animasi bergerak\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const vidBuf = await makeBratVideoSticker(textInput);
        const attachment = new AttachmentBuilder(vidBuf, { name: 'bratvid.webp' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Brat Video Sticker Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal membuat Brat Video: ${err.message}` });
      }
      break;
    }

    case 'qc': {
      const textInput = await getContextText(message, args);
      if (!textInput) {
        const text = `⚠️ Masukkan kutipan teks! Contoh: \`${prefix}qc Halo dunia\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const qcBuf = await makeQcSticker({
          text: textInput,
          name: authorName,
          avatarUrl: avatarUrl
        });
        const attachment = new AttachmentBuilder(qcBuf, { name: 'quote.webp' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Quote Chat Sticker Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal membuat QC: ${err.message}` });
      }
      break;
    }

    case 'smeme': {
      const media = await getMediaBuffer(message, args);
      if (!media) {
        const text = `⚠️ Kirim/reply gambar dengan: \`${prefix}smeme teks atas|teks bawah\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      const parts = args.join(' ').split('|');
      const topText = (parts[0] || '').trim();
      const bottomText = (parts[1] || '').trim();
      try {
        const smemeBuf = await makeSmemeSticker(media.buffer, topText, bottomText);
        const attachment = new AttachmentBuilder(smemeBuf, { name: 'smeme.webp' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Sticker Meme Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal membuat Meme: ${err.message}` });
      }
      break;
    }

    case 'ttp':
    case 'attp': {
      const textInput = await getContextText(message, args);
      if (!textInput) {
        const text = `⚠️ Masukkan teks! Contoh: \`${prefix}${command} Teks Keren\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const fn = command === 'attp' ? makeAttpSticker : makeTtpSticker;
        const buf = await fn(textInput);
        const attachment = new AttachmentBuilder(buf, { name: `${command}.webp` });
        await message.reply({ files: [attachment] });
        replyTextOutput = `[${command.toUpperCase()} Sticker Terkirim]`;
      } catch (err) {
        await message.reply({ content: `❌ Gagal: ${err.message}` });
      }
      break;
    }

    // --- AUDIO & SUARA ---
    case 'tts': {
      const textInput = await getContextText(message, args);
      if (!textInput) {
        const text = `⚠️ Masukkan teks yang ingin dibacakan! Contoh: \`${prefix}tts Selamat pagi semuanya\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const audioBuf = await getGoogleTts(textInput, 'id');
        const attachment = new AttachmentBuilder(audioBuf, { name: 'tts.mp3' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Audio TTS Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal TTS: ${err.message}` });
      }
      break;
    }

    case 'bass':
    case 'slow':
    case 'robot':
    case 'chipmunk': {
      const media = await getMediaBuffer(message, args);
      if (!media) {
        const text = `⚠️ Kirim/reply file audio atau voice dengan \`${prefix}${command}\`.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const filteredBuf = await applyAudioEffect(media.buffer, command);
        const attachment = new AttachmentBuilder(filteredBuf, { name: `${command}.mp3` });
        await message.reply({ files: [attachment] });
        replyTextOutput = `[Audio Filter ${command} Terkirim]`;
      } catch (err) {
        await message.reply({ content: `❌ Gagal filter audio: ${err.message}` });
      }
      break;
    }

    // --- INFORMASI & UTILITAS ---
    case 'calc': {
      const expr = args.join(' ').trim();
      if (!expr) {
        const text = `⚠️ Masukkan ekspresi matematika! Contoh: \`${prefix}calc 25 * 4 + 10\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        // Sanitasi hanya angka dan operator matematika aman
        if (!/^[0-9+\-*/().^ %]+$/.test(expr)) {
          throw new Error('Karakter tidak valid!');
        }
        const sanitized = expr.replace(/\^/g, '**');
        const result = Function(`'use strict'; return (${sanitized})`)();
        const text = `🔢 **Kalkulator:**\n\`${expr}\` = **${result}**`;
        await message.reply({ content: text });
        replyTextOutput = text;
      } catch (err) {
        const text = '❌ Format hitungan salah atau tidak valid!';
        await message.reply({ content: text });
        replyTextOutput = text;
      }
      break;
    }

    case 'cuaca':
    case 'weather': {
      const city = args.join(' ').trim() || 'Jakarta';
      try {
        const data = await getWeather(city);
        const embed = new EmbedBuilder()
          .setColor(0x00A8FF)
          .setTitle(`🌤️ Cuaca di ${data.kota || city}`)
          .setDescription(`**Kondisi:** ${data.kondisi || data.cuaca || 'Cerah'}`)
          .addFields(
            { name: '🌡️ Suhu', value: `${data.suhu || '-'}°C`, inline: true },
            { name: '💧 Kelembaban', value: `${data.kelembaban || '-'}%`, inline: true },
            { name: '💨 Angin', value: `${data.angin || '-'} km/j`, inline: true }
          )
          .setTimestamp();
        await message.reply({ embeds: [embed] });
        replyTextOutput = `Cuaca di ${city}: ${data.suhu}°C`;
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengambil data cuaca: ${err.message}` });
      }
      break;
    }

    case 'sholat':
    case 'jadwalsholat': {
      const city = args.join(' ').trim() || 'Jakarta';
      try {
        const data = await getJadwalSholat(city);
        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle(`🕌 Jadwal Sholat - ${data.kota || city}`)
          .setDescription(`Tanggal: ${data.tanggal || new Date().toLocaleDateString('id-ID')}`)
          .addFields(
            { name: 'Imsak', value: data.imsak || '-', inline: true },
            { name: 'Subuh', value: data.subuh || '-', inline: true },
            { name: 'Dzuhur', value: data.dzuhur || '-', inline: true },
            { name: 'Ashar', value: data.ashar || '-', inline: true },
            { name: 'Maghrib', value: data.maghrib || '-', inline: true },
            { name: 'Isya', value: data.isya || '-', inline: true }
          )
          .setTimestamp();
        await message.reply({ embeds: [embed] });
        replyTextOutput = `Jadwal sholat ${city} berhasil ditampilkan.`;
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengambil jadwal sholat: ${err.message}` });
      }
      break;
    }

    case 'gempa': {
      try {
        const data = await getGempaBmkg();
        const embed = new EmbedBuilder()
          .setColor(0xE74C3C)
          .setTitle('🚨 Info Gempa Bumi Terkini (BMKG)')
          .setDescription(data.wilayah || 'Indonesia')
          .addFields(
            { name: 'Magnitude', value: `${data.magnitude || '-'} SR`, inline: true },
            { name: 'Kedalaman', value: data.kedalaman || '-', inline: true },
            { name: 'Waktu', value: `${data.tanggal || ''} ${data.jam || ''}`, inline: true },
            { name: 'Koordinat', value: data.coordinates || '-', inline: true },
            { name: 'Potensi', value: data.potensi || 'Tidak berpotensi tsunami' }
          )
          .setTimestamp();

        if (data.shakemap) {
          embed.setImage(data.shakemap);
        }
        await message.reply({ embeds: [embed] });
        replyTextOutput = `Info Gempa BMKG: ${data.magnitude} SR - ${data.wilayah}`;
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengambil data gempa: ${err.message}` });
      }
      break;
    }

    case 'wiki':
    case 'wikipedia': {
      const q = args.join(' ').trim();
      if (!q) {
        const text = `⚠️ Masukkan kata kunci! Contoh: \`${prefix}wiki Indonesia\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const summary = await getWikiSummary(q);
        const embed = new EmbedBuilder()
          .setColor(0x95A5A6)
          .setTitle(`📚 Wikipedia: ${q}`)
          .setDescription(summary.length > 2048 ? summary.substring(0, 2040) + '...' : summary)
          .setTimestamp();
        await message.reply({ embeds: [embed] });
        replyTextOutput = summary;
      } catch (err) {
        await message.reply({ content: `❌ Gagal mencari Wikipedia: ${err.message}` });
      }
      break;
    }

    case 'surah':
    case 'quran': {
      const num = parseInt(args[0], 10);
      const ayat = args[1] ? parseInt(args[1], 10) : null;
      if (!num || isNaN(num)) {
        const text = `⚠️ Masukkan nomor surah! Contoh: \`${prefix}surah 1\` atau \`${prefix}surah 1 2\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const data = await getSurah(num, ayat);
        await message.reply({ content: data });
        replyTextOutput = data;
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengambil surah: ${err.message}` });
      }
      break;
    }

    case 'qr':
    case 'qrcode': {
      const textInput = await getContextText(message, args);
      if (!textInput) {
        const text = `⚠️ Masukkan teks atau link untuk QR! Contoh: \`${prefix}qr https://google.com\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const qrBuf = await generateQrBuffer(textInput);
        const attachment = new AttachmentBuilder(qrBuf, { name: 'qrcode.png' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[QR Code Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal membuat QR: ${err.message}` });
      }
      break;
    }

    case 'short':
    case 'shortlink': {
      const url = args[0];
      if (!url || !/^https?:\/\//i.test(url)) {
        const text = `⚠️ Masukkan URL valid! Contoh: \`${prefix}short https://youtube.com\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const short = await shortenUrl(url);
        const text = `🔗 **Link Singkat:** ${short}`;
        await message.reply({ content: text });
        replyTextOutput = text;
      } catch (err) {
        await message.reply({ content: `❌ Gagal perpendek link: ${err.message}` });
      }
      break;
    }

    case 'ssweb':
    case 'screenshot': {
      const url = args[0];
      if (!url || !/^https?:\/\//i.test(url)) {
        const text = `⚠️ Masukkan URL! Contoh: \`${prefix}ssweb https://discord.com\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const ssBuf = await getWebScreenshot(url);
        const attachment = new AttachmentBuilder(ssBuf, { name: 'screenshot.jpg' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Web Screenshot Terkirim]';
      } catch (err) {
        await message.reply({ content: `❌ Gagal screenshot web: ${err.message}` });
      }
      break;
    }

    // --- DOWNLOADER & SEARCH ---
    case 'tiktok':
    case 'tt': {
      const url = args[0];
      if (!url) {
        const text = `⚠️ Masukkan link video TikTok! Contoh: \`${prefix}tiktok https://vt.tiktok.com/...\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      await message.channel.send('⏳ Mengunduh video TikTok...');
      try {
        const videoData = await getTikTokVideo(url);
        if (videoData.buffer) {
          const attachment = new AttachmentBuilder(videoData.buffer, { name: 'tiktok.mp4' });
          await message.reply({ content: `🎵 **${videoData.title || 'TikTok Video'}**`, files: [attachment] });
          replyTextOutput = '[Video TikTok Terkirim]';
        } else if (videoData.videoUrl) {
          await message.reply({ content: `✅ Link Download Video:\n${videoData.videoUrl}` });
          replyTextOutput = videoData.videoUrl;
        }
      } catch (err) {
        await message.reply({ content: `❌ Gagal download TikTok: ${err.message}` });
      }
      break;
    }

    case 'pin':
    case 'pinterest':
    case 'img': {
      const q = args.join(' ').trim();
      if (!q) {
        const text = `⚠️ Masukkan kata kunci pencarian! Contoh: \`${prefix}${command} anime wallpaper\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const imgUrl = await searchImage(q);
        const embed = new EmbedBuilder()
          .setColor(0xE67E22)
          .setTitle(`🔍 Hasil Gambar: ${q}`)
          .setImage(imgUrl)
          .setTimestamp();
        await message.reply({ embeds: [embed] });
        replyTextOutput = `Gambar ditemukan untuk: ${q}`;
      } catch (err) {
        await message.reply({ content: `❌ Gagal mencari gambar: ${err.message}` });
      }
      break;
    }

    // --- GAMES & FUN ---
    case 'dadu': {
      const roll = Math.floor(Math.random() * 6) + 1;
      const text = `🎲 **${authorName}** melempar dadu dan mendapatkan angka: **${roll}**!`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'koin': {
      const coin = Math.random() < 0.5 ? 'Gambar' : 'Angka';
      const text = `🪙 Koin dilempar... hasilnya adalah: **${coin}**!`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'apakah': {
      const q = args.join(' ');
      if (!q) {
        const text = `⚠️ Masukkan pertanyaan! Contoh: \`${prefix}apakah hari ini hujan?\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      const answers = ['Ya, tentu saja!', 'Bisa jadi', 'Sepertinya tidak', 'Pasti!', 'Mustahil', 'Mungkin iya', 'Tanyakan lagi nanti'];
      const pick = answers[Math.floor(Math.random() * answers.length)];
      const text = `🔮 **Pertanyaan:** ${q}\n**Jawaban:** ${pick}`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'rate': {
      const target = args.join(' ') || authorName;
      const percent = Math.floor(Math.random() * 101);
      const text = `📊 Rating untuk **${target}** adalah: **${percent}%**!`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'siapakah': {
      if (!message.guild) {
        const text = '⚠️ Perintah ini hanya bisa digunakan di dalam server!';
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      const members = await message.guild.members.fetch();
      const nonBots = members.filter(m => !m.user.bot);
      const randomMember = nonBots.random();
      const text = `🤔 Yang paling cocok adalah: **${randomMember ? randomMember.displayName : authorName}**!`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'tebakkata': {
      const channelId = message.channel.id;
      if (activeTebakKata.has(channelId)) {
        await message.reply({ content: '⚠️ Masih ada tebak kata yang sedang berlangsung di channel ini!' });
        return;
      }
      try {
        const game = await getRandomTebakKata();
        const session = {
          jawaban: game.jawaban.toLowerCase().trim(),
          soal: game.soal,
          timer: setTimeout(async () => {
            if (activeTebakKata.has(channelId)) {
              await message.channel.send(`⏰ **Waktu Habis!** Jawabannya adalah: **${session.jawaban.toUpperCase()}**`);
              activeTebakKata.delete(channelId);
            }
          }, 60000)
        };
        activeTebakKata.set(channelId, session);
        await message.reply({
          content: `🎯 **TEBAK KATA**\nPetunjuk: "${game.soal}"\nWaktu: **60 detik**\nKetik langsung tebakanmu di chat!`
        });
        replyTextOutput = `Soal Tebak Kata: ${game.soal}`;
      } catch (err) {
        await message.reply({ content: `❌ Gagal memulai tebak kata: ${err.message}` });
      }
      break;
    }

    
    // --- RESTORED COMMANDS: DOWNLOADER ---
    case 'ig':
    case 'igdl':
    case 'instagram': {
      const url = args[0] || (await getContextText(message, args));
      if (!url || !url.includes('instagram.com')) {
        const text = `⚠️ Masukkan link Instagram! Contoh: \`${prefix}ig https://www.instagram.com/reel/...\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        await message.channel.sendTyping();
        const media = await getInstagramMedia(url);
        if (media && media.url) {
          const res = await axios.get(media.url, { responseType: 'arraybuffer', timeout: 45000 });
          const isVideo = media.isVideo || media.url.includes('.mp4');
          const ext = isVideo ? 'mp4' : 'jpg';
          const file = new AttachmentBuilder(Buffer.from(res.data), { name: `instagram.${ext}` });
          await message.reply({
            content: `✅ **Instagram Downloader**\n${media.caption ? `💬 *${media.caption.slice(0, 150)}...*` : ''}`,
            files: [file]
          });
          replyTextOutput = 'Instagram media berhasil dikirim.';
        } else {
          await message.reply({ content: '❌ Tidak dapat menemukan media dari link Instagram tersebut.' });
        }
      } catch (err) {
        await message.reply({ content: `❌ Gagal download Instagram: ${err.message}` });
      }
      break;
    }

    case 'dl': {
      const url = args[0] || (await getContextText(message, args));
      if (!url) {
        const text = `⚠️ Masukkan link media (TikTok / Instagram)! Contoh: \`${prefix}dl <link>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      if (url.includes('instagram.com')) {
        return handleCommand({ message, command: 'ig', args: [url], rawText });
      } else if (url.includes('tiktok.com')) {
        return handleCommand({ message, command: 'tiktok', args: [url], rawText });
      } else {
        await message.reply({ content: '⚠️ Saat ini auto-downloader mendukung link **TikTok** dan **Instagram**!' });
      }
      break;
    }

    // --- RESTORED COMMANDS: AUDIO TOOLS ---
    case 'tomp3':
    case 'tovn': {
      try {
        await message.channel.sendTyping();
        const media = await getMediaBuffer(message, args);
        if (!media || !media.buffer) {
          const text = '⚠️ Reply atau lampirkan video yang ingin diekstrak audionya!';
          await message.reply({ content: text });
          replyTextOutput = text;
          return replyTextOutput;
        }
        const mp3Buf = await extractAudioFromVideo(media.buffer);
        const file = new AttachmentBuilder(mp3Buf, { name: 'audio.mp3' });
        await message.reply({ content: '🎵 Audio berhasil diekstrak!', files: [file] });
        replyTextOutput = 'Audio berhasil diekstrak.';
      } catch (err) {
        await message.reply({ content: `❌ Gagal ekstrak audio: ${err.message}` });
      }
      break;
    }

    case 'transkrip':
    case 'toteks': {
      try {
        await message.channel.sendTyping();
        const media = await getMediaBuffer(message, args);
        if (!media || !media.buffer) {
          const text = '⚠️ Reply atau lampirkan pesan suara/audio yang ingin ditranskrip!';
          await message.reply({ content: text });
          replyTextOutput = text;
          return replyTextOutput;
        }
        const ext = media.name ? path.extname(media.name).replace('.', '') : 'mp3';
        const transcript = await transcribeAudio(media.buffer, ext);
        const text = `🎙️ **Hasil Transkrip Suara:**\n\n"${transcript}"`;
        await message.reply({ content: text });
        replyTextOutput = transcript;
      } catch (err) {
        await message.reply({ content: `❌ Gagal transkrip audio: ${err.message}` });
      }
      break;
    }

    // --- RESTORED COMMANDS: AI SUMMARY & TRANSLATE ---
    case 'ringkas':
    case 'summarize': {
      let input = args.join(' ').trim();
      if (!input && message.reference && message.reference.messageId) {
        input = await getContextText(message, args);
      }
      if (!input) {
        const text = `⚠️ Masukkan link artikel atau teks yang ingin diringkas! Contoh: \`${prefix}ringkas https://kompas.com/...\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        await message.channel.sendTyping();
        let textToSummarize = input;
        if (/^https?:\/\//i.test(input)) {
          textToSummarize = await fetchAndExtractText(input);
        }
        const prompt = `Tolong ringkaskan teks berikut ini dalam bahasa Indonesia yang padat, jelas, dan mudah dipahami dalam bentuk poin-poin penting:\n\n${textToSummarize.slice(0, 4000)}`;
        const summary = await askAI(prompt, userId, 'Kamu adalah asisten perangkum teks profesional.');
        await message.reply({ content: `📝 **Ringkasan:**\n\n${summary}` });
        replyTextOutput = summary;
      } catch (err) {
        await message.reply({ content: `❌ Gagal meringkas: ${err.message}` });
      }
      break;
    }

    case 'tr':
    case 'translate': {
      let targetLang = 'id';
      let textToTr = '';

      if (args.length >= 2 && args[0].length <= 5) {
        targetLang = args[0].toLowerCase();
        textToTr = args.slice(1).join(' ');
      } else if (args.length === 1 && args[0].length <= 5) {
        targetLang = args[0].toLowerCase();
        textToTr = await getContextText(message, []);
      } else {
        textToTr = args.join(' ');
      }

      if (!textToTr && message.reference && message.reference.messageId) {
        textToTr = await getContextText(message, []);
      }

      if (!textToTr) {
        const text = `⚠️ Format: \`${prefix}tr <kode_bahasa> <teks>\` atau reply pesan lalu \`${prefix}tr <kode_bahasa>\`\nContoh: \`${prefix}tr en Halo selamat pagi\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      try {
        await message.channel.sendTyping();
        const translated = await translateText(textToTr, targetLang);
        const text = `🌐 **Terjemahan (${targetLang.toUpperCase()}):**\n\n${translated}`;
        await message.reply({ content: text });
        replyTextOutput = translated;
      } catch (err) {
        await message.reply({ content: `❌ Gagal menerjemahkan: ${err.message}` });
      }
      break;
    }

    // --- RESTORED COMMANDS: MENFESS / CONFESS ---
    case 'menfess':
    case 'confess': {
      const targetUser = message.mentions.users.first() || (args[0] && /^\d{17,20}$/.test(args[0]) ? await client.users.fetch(args[0]).catch(() => null) : null);
      const textMsg = targetUser ? (message.mentions.users.first() ? args.slice(1).join(' ') : args.slice(1).join(' ')) : '';

      if (!targetUser || !textMsg) {
        const text = `💌 **Format Menfess (Pesan Rahasia Anonim):**\n\`${prefix}menfess @user <pesan kamu>\` atau \`${prefix}menfess <User_ID> <pesan kamu>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      try {
        const embed = new EmbedBuilder()
          .setColor(0xFF69B4)
          .setTitle('💌 Pesan Rahasia Menfess Baru!')
          .setDescription(`"${textMsg}"`)
          .setFooter({ text: 'Pengirim dirahasiakan oleh bot • Balas lewat bot tidak tersedia' })
          .setTimestamp();

        await targetUser.send({ embeds: [embed] });

        if (message.guild && message.deletable) {
          try { await message.delete(); } catch (_) {}
        }

        const confirmMsg = await message.channel.send({ content: `✅ Pesan rahasia berhasil dikirimkan ke **${targetUser.tag}**!` });
        setTimeout(() => confirmMsg.delete().catch(() => {}), 5000);
        replyTextOutput = 'Menfess terkirim.';
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengirim menfess ke user tersebut (mungkin DM ditutup): ${err.message}` });
      }
      break;
    }

    // --- RESTORED COMMANDS: SERVER MODERATION ---
    case 'kick': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply('❌ Kamu tidak memiliki izin `Kick Members`!');
      }
      const target = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0]).catch(() => null) : null);
      if (!target) return message.reply(`⚠️ Sebutkan member yang ingin di-kick! Contoh: \`${prefix}kick @user [alasan]\``);
      if (!target.kickable) return message.reply('❌ Bot tidak memiliki hak untuk meng-kick member ini!');
      const reason = args.slice(1).join(' ') || 'Tidak ada alasan';
      try {
        await target.kick(reason);
        await message.reply(`👢 **${target.user.tag}** berhasil di-kick dari server.\nAlasan: *${reason}*`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal kick: ${err.message}` });
      }
      break;
    }

    case 'ban': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply('❌ Kamu tidak memiliki izin `Ban Members`!');
      }
      const target = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0]).catch(() => null) : null);
      if (!target) return message.reply(`⚠️ Sebutkan member yang ingin di-ban! Contoh: \`${prefix}ban @user [alasan]\``);
      if (!target.bannable) return message.reply('❌ Bot tidak memiliki hak untuk mem-ban member ini!');
      const reason = args.slice(1).join(' ') || 'Tidak ada alasan';
      try {
        await target.ban({ reason });
        await message.reply(`🔨 **${target.user.tag}** berhasil di-ban dari server.\nAlasan: *${reason}*`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal ban: ${err.message}` });
      }
      break;
    }

    case 'unban': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply('❌ Kamu tidak memiliki izin `Ban Members`!');
      }
      const uId = args[0];
      if (!uId) return message.reply(`⚠️ Masukkan User ID yang ingin di-unban! Contoh: \`${prefix}unban 1234567890\``);
      try {
        await message.guild.bans.remove(uId);
        await message.reply(`🔓 User ID \`${uId}\` berhasil di-unban!`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal unban: ${err.message}` });
      }
      break;
    }

    case 'mute':
    case 'timeout': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply('❌ Kamu tidak memiliki izin `Timeout / Moderate Members`!');
      }
      const target = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0]).catch(() => null) : null);
      if (!target) return message.reply(`⚠️ Sebutkan member! Contoh: \`${prefix}mute @user [menit]\``);
      const minutes = parseInt(args[1]) || 10;
      try {
        await target.timeout(minutes * 60 * 1000, `Mute oleh ${message.author.tag}`);
        await message.reply(`🔇 **${target.user.tag}** berhasil di-mute selama **${minutes} menit**.`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal mute: ${err.message}` });
      }
      break;
    }

    case 'unmute': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply('❌ Kamu tidak memiliki izin `Timeout / Moderate Members`!');
      }
      const target = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0]).catch(() => null) : null);
      if (!target) return message.reply(`⚠️ Sebutkan member! Contoh: \`${prefix}unmute @user\``);
      try {
        await target.timeout(null);
        await message.reply(`🔊 **${target.user.tag}** berhasil di-unmute.`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal unmute: ${err.message}` });
      }
      break;
    }

    case 'clearchat':
    case 'purge':
    case 'clear':
    case 'delchat':
    case 'hapuschat': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return message.reply('❌ Kamu tidak memiliki izin `Manage Messages`!');
      }
      const count = Math.min(Math.max(parseInt(args[0]) || 10, 1), 100);
      try {
        const deleted = await message.channel.bulkDelete(count, true);
        const notice = await message.channel.send(`🧹 Berhasil membersihkan **${deleted.size}** pesan!`);
        setTimeout(() => notice.delete().catch(() => {}), 4000);
      } catch (err) {
        await message.reply({ content: `❌ Gagal menghapus pesan: ${err.message}` });
      }
      break;
    }

    case 'slowmode': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return message.reply('❌ Kamu tidak memiliki izin `Manage Channels`!');
      }
      const sec = parseInt(args[0]);
      if (isNaN(sec) || sec < 0) return message.reply(`⚠️ Format: \`${prefix}slowmode <detik>\` (0 untuk mematikan)`);
      try {
        await message.channel.setRateLimitPerUser(sec);
        await message.reply(`⏱️ Slowmode channel diatur ke **${sec} detik**.`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengatur slowmode: ${err.message}` });
      }
      break;
    }

    case 'tagall':
    case 'hidetag': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.MentionEveryone)) {
        return message.reply('❌ Kamu tidak memiliki izin `Mention Everyone`!');
      }
      const pesan = args.join(' ') || 'Perhatian untuk semua member!';
      await message.channel.send({ content: `@everyone\n📢 **PENGUMUMAN:** ${pesan}` });
      break;
    }

    case 'groupinfo':
    case 'serverinfo': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      const guild = message.guild;
      const owner = await guild.fetchOwner();
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🏰 Informasi Server: ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .addFields(
          { name: '👑 Pemilik Server', value: `${owner.user.tag} (${owner.id})`, inline: true },
          { name: '👥 Total Member', value: `${guild.memberCount} member`, inline: true },
          { name: '💬 Total Channel', value: `${guild.channels.cache.size} channel`, inline: true },
          { name: '🎭 Total Role', value: `${guild.roles.cache.size} role`, inline: true },
          { name: '🛡️ Tingkat Verifikasi', value: `${guild.verificationLevel}`, inline: true },
          { name: '📅 Dibuat Pada', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true }
        )
        .setFooter({ text: `Server ID: ${guild.id}` })
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      break;
    }

    case 'userinfo': {
      const user = message.mentions.users.first() || message.author;
      const member = message.guild ? await message.guild.members.fetch(user.id).catch(() => null) : null;
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`👤 Info Pengguna: ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: '🆔 User ID', value: user.id, inline: true },
          { name: '🤖 Bot?', value: user.bot ? 'Ya' : 'Bukan', inline: true },
          { name: '📅 Akun Dibuat', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
          ...(member ? [
            { name: '📥 Bergabung ke Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
            { name: '🎭 Role Tertinggi', value: `${member.roles.highest.name}`, inline: true }
          ] : [])
        )
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      break;
    }

    case 'setname': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
        return message.reply('❌ Kamu tidak memiliki izin `Manage Nicknames`!');
      }
      const newName = args.join(' ');
      if (!newName) return message.reply(`⚠️ Masukkan nama baru bot! Contoh: \`${prefix}setname Bot Keren\``);
      try {
        await message.guild.members.me.setNickname(newName);
        await message.reply(`✅ Nickname bot di server ini diubah menjadi **${newName}**!`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengubah nama: ${err.message}` });
      }
      break;
    }

    case 'setdesc': {
      if (!message.guild) return message.reply('⚠️ Perintah ini hanya bisa digunakan di server!');
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return message.reply('❌ Kamu tidak memiliki izin `Manage Channels`!');
      }
      const topic = args.join(' ');
      try {
        await message.channel.setTopic(topic);
        await message.reply(`✅ Topik channel berhasil diperbarui!`);
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengubah topik channel: ${err.message}` });
      }
      break;
    }

    // --- ALIASES ---
    case 'bratgif':
    case 'bratwhite': {
      return handleCommand({ message, command: 'brat', args, rawText });
    }

    default:
      // Perintah tidak dikenal
      break;
  }

  return replyTextOutput;
}

// Event: Message Create
client.on('messageCreate', async (message) => {
  // Abaikan pesan dari sesama bot
  if (message.author.bot) return;

  const channelId = message.channel.id;

  // Cek apakah ada game tebak kata yang sedang aktif di channel ini
  if (activeTebakKata.has(channelId)) {
    const session = activeTebakKata.get(channelId);
    const guess = message.content.toLowerCase().trim();
    if (guess === session.jawaban) {
      clearTimeout(session.timer);
      activeTebakKata.delete(channelId);
      await message.reply({
        content: `🎉 **BENAR!** Selamat **${message.author.displayName || message.author.username}**, jawabannya memang **${session.jawaban.toUpperCase()}**!`
      });
      return;
    }
  }

  const prefix = config.prefix || '.';
  if (!message.content.startsWith(prefix)) return;

  // Rate Limiting Cooldown
  const userId = message.author.id;
  const now = Date.now();
  if (userCooldowns.has(userId) && (now - userCooldowns.get(userId) < COOLDOWN_MS)) {
    return; // Abaikan jika spam command terlalu cepat
  }
  userCooldowns.set(userId, now);

  const [commandWithPrefix, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = (commandWithPrefix || '').toLowerCase();

  try {
    await handleCommand({
      message,
      command,
      args,
      rawText: message.content
    });
  } catch (err) {
    console.error(`Error saat menjalankan perintah [${command}]:`, err);
    try {
      await message.reply({ content: `❌ Terjadi kesalahan internal: ${err.message}` });
    } catch (_) {}
  }
});

// Event: Client Ready
client.once('ready', () => {
  console.log('========================================');
  console.log(`✅ ${config.botName} Berhasil Terhubung & Aktif!`);
  console.log(`🤖 Logged in as: ${client.user.tag} (ID: ${client.user.id})`);
  console.log(`🌐 Server Terhubung: ${client.guilds.cache.size} server`);
  console.log('========================================');
  client.user.setActivity({
    name: `${config.prefix}menu | ${config.botName}`,
    type: ActivityType.Playing
  });

  startIpcServer();
});

// HTTP IPC Server untuk pengiriman dari console (send.js)
function startIpcServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { target, message: textToSend } = JSON.parse(body);
          if (!textToSend) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Pesan kosong' }));
          }

          // Cari channel Discord yang dituju
          let targetChannel = null;
          if (target && target !== 'default' && target !== 'channel') {
            try {
              targetChannel = await client.channels.fetch(target);
            } catch (_) {}
          }

          // Jika target default atau tidak ditemukan, pilih text channel pertama yang bisa diakses
          if (!targetChannel) {
            for (const guild of client.guilds.cache.values()) {
              const ch = guild.channels.cache.find(c => c.isTextBased() && c.viewable);
              if (ch) {
                targetChannel = ch;
                break;
              }
            }
          }

          if (!targetChannel) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ 
              success: false, 
              error: 'Tidak ada channel Discord yang dapat diakses oleh bot saat ini.' 
            }));
          }

          const prefix = config.prefix || '.';
          const isCommand = textToSend.startsWith(prefix);

          if (isCommand) {
            const [cmdRaw, ...args] = textToSend.slice(prefix.length).trim().split(/\s+/);
            const command = (cmdRaw || '').toLowerCase();

            // Mock message object untuk eksekusi via console
            let sentDiscordMsg = null;
            const mockMsg = {
              author: { id: 'console-owner', username: 'Console', displayName: 'Console Admin' },
              content: textToSend,
              createdTimestamp: Date.now(),
              channel: targetChannel,
              guild: targetChannel.guild,
              attachments: new Map(),
              reply: async (payload) => {
                sentDiscordMsg = await targetChannel.send(payload);
                return sentDiscordMsg;
              }
            };

            const replyText = await handleCommand({
              message: mockMsg,
              command,
              args,
              rawText: textToSend
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              isCommand: true,
              command: `.${command}`,
              replyText: replyText || '',
              channelName: `#${targetChannel.name} (${targetChannel.guild?.name || 'DM'})`
            }));
          } else {
            // Pesan teks biasa ke channel
            await targetChannel.send(textToSend);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              isCommand: false,
              channelName: `#${targetChannel.name} (${targetChannel.guild?.name || 'DM'})`
            }));
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  const port = config.ipcPort || 45678;
  server.listen(port, '127.0.0.1', () => {
    console.log(`💡 [Console Panel Aktif] Ketik langsung di terminal:`);
    console.log(`   node send.js default <pesan/command>`);
    console.log(`   Contoh: node send.js default .menu`);
    console.log(`           node send.js default .ai siapa itu messi`);
  });
}

// Inisialisasi Login Bot Discord
const botToken = config.token;
if (!botToken) {
  console.error('❌ ERROR: Token Discord belum diisi!');
  console.error('   Masukkan DISCORD_TOKEN di environment variables atau buat file .env.');
  process.exit(1);
}

console.log('Menghubungkan ke Discord Gateway...');
client.login(botToken).catch((err) => {
  console.error('❌ Gagal login ke Discord:', err.message);
  if (err.message.includes('disallowed intents') || err.message.includes('DisallowedIntents')) {
    console.error('\n⚠️ PERHATIAN PRIVILEGED INTENTS:');
    console.error('   Bot ini memerlukan izin "Message Content Intent".');
    console.error('   1. Buka https://discord.com/developers/applications');
    console.error('   2. Pilih bot kamu -> Tab "Bot"');
    console.error('   3. Scroll ke "Privileged Gateway Intents"');
    console.error('   4. Nyalakan switch "Message Content Intent" & simpan perubahan (Save Changes).\n');
  }
  process.exit(1);
});
