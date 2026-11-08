const http = require('http');
const readline = require('readline');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { makeSticker, stickerToImage } = require('./src/sticker');
const { makeBratSticker, makeBratVideoSticker } = require('./src/brat');
const { printPterodactylBanner } = require('./src/banner');
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
  getRandomTebakKata
} = require('./src/extended');

// Tracking sesi game aktif di chat
const activeGames = new Map();

const { upscaleImage } = require('./src/hd');
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

// Tracking cooldown untuk fitur anti-blokir
const userCooldowns = new Map();
const userMsgCounts = new Map();

// Sesi memori percakapan AI per pengirim (hemat RAM 256MB)
const aiChatSessions = new Map();
const aiSettingsFile = path.join(__dirname, 'data', 'ai-settings.json');
const aiSettings = new Map();
try {
  fs.mkdirSync(path.dirname(aiSettingsFile), { recursive: true });
  const savedAiSettings = JSON.parse(fs.readFileSync(aiSettingsFile, 'utf8'));
  for (const [jid, settings] of Object.entries(savedAiSettings)) {
    if (settings && typeof settings === 'object') aiSettings.set(jid, settings);
  }
} catch (err) {
  if (err.code !== 'ENOENT') console.warn('[AI Settings] Gagal membaca file persona:', err.message);
}

function saveAiSettings() {
  fs.mkdirSync(path.dirname(aiSettingsFile), { recursive: true });
  const tempFile = `${aiSettingsFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(Object.fromEntries(aiSettings), null, 2), { mode: 0o600 });
  try { fs.chmodSync(tempFile, 0o600); } catch {}
  fs.renameSync(tempFile, aiSettingsFile);
}

function getQuotedText(rawMsg) {
  const context = rawMsg?.extendedTextMessage?.contextInfo;
  if (!context?.quotedMessage) return '';
  const quoted = unwrapMessage({ message: context.quotedMessage });
  if (!quoted) return '';
  return String(
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    quoted.documentMessage?.caption ||
    quoted.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    quoted.buttonsResponseMessage?.selectedDisplayText ||
    quoted.listResponseMessage?.title ||
    ''
  ).trim();
}

// Bersihkan riwayat AI yang sudah tidak aktif lebih dari 30 menit
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of aiChatSessions.entries()) {
    if (now - (session.lastActive || 0) > 30 * 60 * 1000) {
      aiChatSessions.delete(key);
    }
  }
}, 5 * 60 * 1000);

function isCoolingDown(sender) {
  const now = Date.now();
  const lastTime = userCooldowns.get(sender) || 0;
  if (now - lastTime < config.antiBan.userCooldownMs) {
    return true;
  }
  userCooldowns.set(sender, now);

  // Rate limiting per menit
  const record = userMsgCounts.get(sender) || { count: 0, resetAt: now + 60000 };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + 60000;
  } else {
    record.count++;
  }
  userMsgCounts.set(sender, record);

  return record.count > config.antiBan.maxCommandsPerMinute;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getMentionedJids(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

function getQuotedParticipant(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.participant || null;
}

async function getGroupAdminContext(sock, msg) {
  const groupJid = msg.key.remoteJid;
  if (!groupJid?.endsWith('@g.us')) return { error: 'Perintah ini hanya bisa dipakai di dalam grup.' };
  const metadata = await sock.groupMetadata(groupJid);
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const sender = metadata.participants.find((p) => p.id === senderJid);
  const bot = metadata.participants.find((p) => p.id === sock.user?.id);
  if (!['admin', 'superadmin'].includes(sender?.admin)) return { error: 'Hanya admin grup yang bisa menggunakan perintah ini.' };
  if (!['admin', 'superadmin'].includes(bot?.admin)) return { error: 'Jadikan bot sebagai admin grup terlebih dahulu.' };
  return { groupJid, metadata, senderJid, botJid: sock.user?.id };
}

// Helper untuk unwrap pesan WhatsApp (ephemeral, viewOnce, dll)
function unwrapMessage(msg) {
  let m = msg.message;
  if (!m) return null;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  return m;
}

// Helper untuk download media buffer langsung dari Baileys stream
async function getMediaBuffer(mediaMsg, type = 'image') {
  const stream = await downloadContentFromMessage(mediaMsg, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}


// Global reference untuk bot socket aktif agar bisa diakses oleh Console CLI
let currentSock = null;

// Cache untuk pesan agar Baileys dapat melayani retry receipt ("Menunggu pesan ini")
const messageStore = new Map();
function storeMessage(keyId, message) {
  if (!keyId || !message) return;
  if (messageStore.size > 2000) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
  }
  messageStore.set(keyId, message);
}

const msgRetryCounterCache = {
  _cache: new Map(),
  get(key) {
    return this._cache.get(key);
  },
  set(key, value) {
    if (this._cache.size > 2000) {
      const first = this._cache.keys().next().value;
      this._cache.delete(first);
    }
    this._cache.set(key, value);
  },
  del(key) {
    this._cache.delete(key);
  }
};

// Penyimpanan LID akun sendiri untuk pengiriman pesan ke nomor sendiri (Self Chat)
const SELF_LID_FILE = path.resolve(__dirname, 'data', 'self-lid.json');
let knownSelfLid = null;
try {
  if (fs.existsSync(SELF_LID_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SELF_LID_FILE, 'utf-8'));
    if (raw && raw.lid) {
      knownSelfLid = raw.lid;
    }
  }
} catch {}

function saveSelfLid(lid) {
  if (!lid || typeof lid !== 'string' || !lid.endsWith('@lid')) return;
  const cleanLid = lid.split(':')[0].split('@')[0] + '@lid';
  if (knownSelfLid === cleanLid) return;
  knownSelfLid = cleanLid;
  try {
    fs.mkdirSync(path.dirname(SELF_LID_FILE), { recursive: true });
    fs.writeFileSync(SELF_LID_FILE, JSON.stringify({ lid: cleanLid }, null, 2));
  } catch {}
}

function normalizeConsoleJid(rawTarget, sock = currentSock) {
  if (!rawTarget) return null;
  let target = rawTarget.trim();

  const meId = sock?.user?.id || '';
  const meLid = sock?.user?.lid || '';

  const cleanMeNumber = meId ? meId.split(':')[0].split('@')[0].replace(/[^0-9]/g, '') : '';
  const cleanMeLid = meLid ? meLid.split(':')[0].split('@')[0] + '@lid' : (knownSelfLid || null);
  const cleanOwnerNumber = config.ownerNumber ? config.ownerNumber.replace(/[^0-9]/g, '') : '';

  // Keyword 'me' atau 'self' -> nomor/chat bot sendiri
  if (target.toLowerCase() === 'me' || target.toLowerCase() === 'self') {
    if (cleanMeLid) return cleanMeLid;
    if (cleanMeNumber) return cleanMeNumber + '@s.whatsapp.net';
    return cleanOwnerNumber ? cleanOwnerNumber + '@s.whatsapp.net' : null;
  }

  // Keyword 'owner' -> nomor owner di config
  if (target.toLowerCase() === 'owner') {
    if (cleanOwnerNumber === cleanMeNumber && cleanMeLid) {
      return cleanMeLid;
    }
    return cleanOwnerNumber ? cleanOwnerNumber + '@s.whatsapp.net' : null;
  }

  // Jika sudah memiliki suffix JID WhatsApp (@s.whatsapp.net, @g.us, @lid, @newsletter)
  if (target.includes('@')) {
    // Bersihkan format device suffix jika ada (misal: 12345:1@s.whatsapp.net -> 12345@s.whatsapp.net)
    target = target.replace(/:[0-9]+@/, '@');
    return target;
  }

  // Bersihkan karakter non-angka
  let cleanNumber = target.replace(/[^0-9]/g, '');
  if (!cleanNumber) return null;

  // Format 08xx / 8xx -> 628xx
  if (cleanNumber.startsWith('08')) {
    cleanNumber = '62' + cleanNumber.slice(1);
  } else if (cleanNumber.startsWith('8')) {
    cleanNumber = '62' + cleanNumber;
  }

  // JIKA TARGET ADALAH NOMOR BOT SENDIRI (Self Chat)
  if (cleanMeNumber && cleanNumber === cleanMeNumber && cleanMeLid) {
    return cleanMeLid;
  }

  return cleanNumber + '@s.whatsapp.net';
}

async function validateAndResolveJid(sock, targetRaw) {
  if (!targetRaw) {
    return { valid: false, error: 'Target nomor atau grup wajib diisi.' };
  }

  let jid = normalizeConsoleJid(targetRaw, sock);
  if (!jid) {
    return { valid: false, error: `Format nomor/target "${targetRaw}" tidak valid.` };
  }

  if (!sock) {
    return { valid: false, error: 'Koneksi WhatsApp bot belum siap.' };
  }

  const isSelf = jid.endsWith('@lid');

  // Jika target adalah LID (nomor sendiri / self chat)
  if (isSelf) {
    return { valid: true, jid, isLid: true, isSelf: true };
  }

  // Jika target adalah grup (@g.us)
  if (jid.endsWith('@g.us')) {
    try {
      if (typeof sock.groupMetadata === 'function') {
        await sock.groupMetadata(jid);
      }
      return { valid: true, jid, isGroup: true };
    } catch (err) {
      return { valid: false, error: `Grup ${jid} tidak ditemukan atau bot bukan anggota grup tersebut.` };
    }
  }

  // Jika target adalah nomor perorangan (@s.whatsapp.net)
  if (jid.endsWith('@s.whatsapp.net')) {
    try {
      if (typeof sock.onWhatsApp === 'function') {
        const results = await sock.onWhatsApp(jid);
        if (!Array.isArray(results) || results.length === 0 || !results[0]?.exists) {
          const displayNum = jid.split('@')[0];
          return {
            valid: false,
            error: `Nomor ${displayNum} (${targetRaw}) TIDAK terdaftar di WhatsApp!`
          };
        }
        let cleanJid = results[0]?.jid || jid;
        if (cleanJid.includes(':')) {
          cleanJid = cleanJid.split(':')[0] + '@s.whatsapp.net';
        }
        return { valid: true, jid: cleanJid, exists: true };
      }
    } catch (err) {
      console.warn('[onWhatsApp Check Warning]:', err.message);
      return { valid: true, jid, warning: err.message };
    }
  }

  return { valid: true, jid };
}




// Cache ID pesan untuk mencegah duplikasi eksekusi command
const processedCommandIds = new Set();
function markCommandProcessed(msgId) {
  if (!msgId) return;
  if (processedCommandIds.size > 1000) {
    const first = processedCommandIds.keys().next().value;
    processedCommandIds.delete(first);
  }
  processedCommandIds.add(msgId);
}

async function handleBotCommand(sock, {
  sender,
  bodyText,
  msg = null,
  rawMsg = null,
  isFromMe = false,
  userKey = null,
  isConsole = false
}) {
  if (!sock || !sender || !bodyText) return;
  if (!bodyText.startsWith(config.prefix)) return;

  const msgId = msg?.key?.id;
  if (msgId && processedCommandIds.has(msgId)) {
    return;
  }
  if (msgId) {
    markCommandProcessed(msgId);
  }

  if (!userKey) {
    userKey = msg?.key?.participant || sender;
  }

  if (!rawMsg && msg) {
    rawMsg = unwrapMessage(msg);
  }

  const args = bodyText.slice(config.prefix.length).trim().split(/ +/);
  const command = (args.shift() || '').toLowerCase();
  if (!command) return;

  // Perintah tanpa argumen dapat memakai isi pesan yang sedang di-reply.
  const quotedText = getQuotedText(rawMsg);
  if (args.length === 0 && quotedText) args.push(quotedText);

  console.log(`[Pesan Masuk] Command: ${config.prefix}${command} | Dari: ${sender} | Self: ${isFromMe} | Console: ${isConsole}`);

  // Cek proteksi anti-spam (kecuali dari diri sendiri/owner/console)
  if (!isFromMe && !isConsole && isCoolingDown(sender)) {
    console.log(`[Anti-Spam] Mengabaikan spam dari: ${sender}`);
    return;
  }

  // Jeda alami agar tidak seperti bot kaku
  const delay = isConsole ? 350 : Math.floor(
    Math.random() * (config.antiBan.maxTypingDelayMs - config.antiBan.minTypingDelayMs) +
      config.antiBan.minTypingDelayMs
  );
  await sock.sendPresenceUpdate('composing', sender);
  await sleep(delay);

  try {
        switch (command) {
          case 'menu':
          case 'help': {
            const menuText =
              `⚡ *${config.botName.toUpperCase()}* ⚡\n` +
              `_Prefix Bot: "${config.prefix}"_\n\n` +
              `🎨 *STICKER & MEME*\n` +
              `• *${config.prefix}s* : Bikin foto jadi stiker WA\n` +
              `• *${config.prefix}qc <teks>* : Stiker gelembung chat (Fake Chat)\n` +
              `• *${config.prefix}smeme <atas> | <bawah>* : Bikin stiker meme foto\n` +
              `• *${config.prefix}ttp <teks>* : Stiker teks neon keren\n` +
              `• *${config.prefix}attp <teks>* : Stiker teks animasi kelap-kelip pelangi\n` +
              `• *${config.prefix}brat <teks>* : Stiker teks Brat putih\n` +
              `• *${config.prefix}bratvid <teks>* : Stiker video Brat animasi kata demi kata\n` +
              `• *${config.prefix}toimg* : Reply stiker jadi foto kembali\n` +
              `• *${config.prefix}hd* : Tingkatkan kualitas foto ke HD\n\n` +
              `📥 *DOWNLOADER & PENCARIAN*\n` +
              `• *${config.prefix}tt <link>* : Download video TikTok tanpa watermark\n` +
              `• *${config.prefix}pin <kata>* : Cari gambar aesthetic Pinterest / HD\n` +
              `• *${config.prefix}ssweb <link>* : Screenshot tampilan website\n\n` +
              `🎙️ *AUDIO & SUARA*\n` +
              `• *${config.prefix}tts <teks>* : Suara Google Voice Note (Indonesia)\n` +
              `• *${config.prefix}bass* : Reply audio untuk efek bass boost\n` +
              `• *${config.prefix}slow* : Reply audio untuk efek slow + reverb\n` +
              `• *${config.prefix}chipmunk* : Reply audio untuk suara cempreng tupai\n\n` +
              `🤖 *ARTIFICIAL INTELLIGENCE*\n` +
              `• *${config.prefix}ai <tanya>* : Tanya AI (Mendukung memori percakapan)\n` +
              `• *${config.prefix}resetai* : Hapus ingatan percakapan AI\n` +
              `• *${config.prefix}persona <karakter>* : Atur persona AI pribadi\n` +
              `• *${config.prefix}persona reset* : Hapus persona khusus\n\n` +
              `🛠️ *TOOLS & UTILITAS*\n` +
              `• *${config.prefix}gempa* : Info gempa bumi BMKG terkini + peta\n` +
              `• *${config.prefix}menfess <nomor> <pesan>* : Kirim pesan rahasia anonim\n` +
              `• *${config.prefix}s* : Bikin foto jadi stiker WA\n` +
              `• *${config.prefix}brat <teks>* : Stiker teks Brat putih\n` +
              `• *${config.prefix}bratvid <teks>* : Stiker video Brat (animasi kata demi kata)\n` +
              `• *${config.prefix}toimg* : Reply stiker jadi foto kembali\n` +
              `• *${config.prefix}hd* : Tingkatkan kualitas foto ke HD\n` +
              `• *${config.prefix}ai <tanya>* : Tanya AI (Mendukung memori percakapan)\n` +
              `• *${config.prefix}resetai* : Hapus ingatan percakapan AI\n` +
              `• *${config.prefix}persona <karakter>* : Atur persona AI pribadi\n` +
              `• *${config.prefix}persona reset* : Hapus persona khusus\n` +
              `• Reply pesan lalu kirim perintah untuk memakai teksnya sebagai input\n\n` +
              `🛠️ *TOOLS & UTILITAS*\n` +
              `• *${config.prefix}qr <teks/link>* : Buat gambar QR Code\n` +
              `• *${config.prefix}tr <kode> <teks>* : Terjemahan bahasa (.tr en halo)\n` +
              `• *${config.prefix}wiki <kata>* : Cari ringkasan di Wikipedia\n` +
              `• *${config.prefix}short <link>* : Buat shortlink TinyURL\n` +
              `• *${config.prefix}cuaca <kota>* : Cek cuaca & suhu kota realtime\n` +
              `• *${config.prefix}calc <angka>* : Kalkulator (${config.prefix}calc 25*40)\n\n` +
              `🕌 *ISLAMI*\n` +
              `• *${config.prefix}sholat <kota>* : Jadwal sholat harian akurat\n` +
              `• *${config.prefix}surah <1-114>* : Info surah Al-Qur'an lengkap\n\n` +
              `🎲 *GAME & HIBURAN*\n` +
              `• *${config.prefix}tebakkata* : Game tebak kata berhadiah skor\n` +
              `• *${config.prefix}dadu* : Lempar dadu acak 1-6\n` +
              `• *${config.prefix}koin* : Lempar koin (Gambar/Angka)\n` +
              `• *${config.prefix}apakah <teks>* : Jawaban acak bot\n` +
              `• *${config.prefix}siapakah <teks>* : Pilih acak member grup\n` +
              `• *${config.prefix}rate <teks>* : Nilai rating acak 1-100%\n\n` +
              `👥 *GRUP ADMIN*\n` +
              `• *${config.prefix}tagall <pesan>* : Tag semua member secara publik\n` +
              `• *${config.prefix}hidetag <pesan>* : Mention senyap semua member\n` +
              `• *${config.prefix}mute* / *${config.prefix}unmute* : Tutup / Buka obrolan grup\n` +
              `• *${config.prefix}kick* / *${config.prefix}promote* / *${config.prefix}demote* @user\n` +
              `• *${config.prefix}linkgroup* : Ambil tautan undangan grup\n` +
              `• *${config.prefix}setname* & *${config.prefix}setdesc*\n` +
              `• *${config.prefix}groupinfo* : Statistik grup\n\n` +
              `ℹ️ *INFORMASI*\n` +
              `• *${config.prefix}ping* : Kecepatan bot\n` +
              `• *${config.prefix}runtime* : Waktu aktif bot\n` +
              `• *${config.prefix}owner* : Kontak pemilik bot\n\n` +
              `_Ketik perintah sesuai yang diinginkan!_`;

            await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
            break;
          }

          // ------------------ MEDIA & AI ------------------
          
          // ------------------ FITUR BRAT STICKER (PUTIH) ------------------
          case 'brat':
          case 'bratwhite': {
            const targetText = args.join(' ').trim();
            if (!targetText) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan kalimat untuk stiker Brat (atau reply pesan teks).\nContoh: *${config.prefix}brat malas banget hari ini*` },
                { quoted: msg }
              );
              break;
            }

            if (targetText.length > 250) {
              await sock.sendMessage(
                sender,
                { text: '⚠️ Teks terlalu panjang, maksimal 250 karakter.' },
                { quoted: msg }
              );
              break;
            }

            try {
              const stickerWebp = await makeBratSticker(targetText, 'white');
              await sock.sendMessage(sender, { sticker: stickerWebp }, { quoted: msg });
            } catch (err) {
              console.error('[Brat Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker Brat: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'bratvid':
          case 'bratvideo':
          case 'bratgif':
          case 'bratv': {
            const targetText = args.join(' ').trim();
            if (!targetText) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan kalimat untuk stiker video Brat (atau reply pesan teks).\nContoh: *${config.prefix}bratvid kamu nanya kenapa aku malas*` },
                { quoted: msg }
              );
              break;
            }

            if (targetText.length > 200) {
              await sock.sendMessage(
                sender,
                { text: '⚠️ Teks terlalu panjang untuk stiker video, maksimal 200 karakter.' },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang membuat stiker video Brat (animasi kata demi kata)...' }, { quoted: msg });

            try {
              const animWebp = await makeBratVideoSticker(targetText, 'white');
              await sock.sendMessage(sender, { sticker: animWebp }, { quoted: msg });
            } catch (err) {
              console.error('[Brat Video Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker video Brat: ' + err.message }, { quoted: msg });
            }
            break;
          }

          // ------------------ FITUR BARU: QUOTE CHAT & MEME STICKER ------------------
          case 'qc': {
            let targetText = args.join(' ').trim();
            let authorName = msg.pushName || userKey.split('@')[0] || 'Seseorang';

            const quoted = rawMsg.extendedTextMessage?.contextInfo;
            if (quoted?.quotedMessage) {
              const unquoted = unwrapMessage({ message: quoted.quotedMessage });
              const qText = unquoted?.conversation || unquoted?.extendedTextMessage?.text || '';
              if (qText) targetText = qText.trim();
              if (quoted.participant) {
                authorName = quoted.participant.split('@')[0];
              }
            }

            if (!targetText) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan kalimat untuk quote atau reply chat orang lain.\nContoh: *${config.prefix}qc kata mutiara hari ini*` },
                { quoted: msg }
              );
              break;
            }

            try {
              const qcWebp = makeQcSticker(targetText, authorName);
              await sock.sendMessage(sender, { sticker: qcWebp }, { quoted: msg });
            } catch (err) {
              console.error('[QC Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker Quote Chat: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'smeme': {
            let targetImage = null;
            if (rawMsg.imageMessage) {
              targetImage = rawMsg.imageMessage;
            } else {
              const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
              if (quoted) {
                const unquoted = unwrapMessage({ message: quoted });
                if (unquoted?.imageMessage) {
                  targetImage = unquoted.imageMessage;
                }
              }
            }

            if (!targetImage) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Kirim foto dengan caption atau reply foto dengan format:\n*${config.prefix}smeme teks atas | teks bawah*` },
                { quoted: msg }
              );
              break;
            }

            const rawText = args.join(' ').trim();
            const parts = rawText.split('|');
            const topText = (parts[0] || '').trim();
            const bottomText = (parts[1] || '').trim();

            if (!topText && !bottomText) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan teks meme!\nContoh: *${config.prefix}smeme teks atas | teks bawah*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang membuat stiker meme...' }, { quoted: msg });

            try {
              const imgBuffer = await getMediaBuffer(targetImage, 'image');
              const memeWebp = makeSmemeSticker(imgBuffer, topText, bottomText);
              await sock.sendMessage(sender, { sticker: memeWebp }, { quoted: msg });
            } catch (err) {
              console.error('[SMeme Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker meme: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'ttp': {
            const targetText = args.join(' ').trim();
            if (!targetText) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan teks untuk stiker TTP!\nContoh: *${config.prefix}ttp Halo Ganteng*` },
                { quoted: msg }
              );
              break;
            }

            try {
              const ttpWebp = makeTtpSticker(targetText);
              await sock.sendMessage(sender, { sticker: ttpWebp }, { quoted: msg });
            } catch (err) {
              console.error('[TTP Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker TTP: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'attp': {
            const targetText = args.join(' ').trim();
            if (!targetText) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan teks untuk stiker animasi ATTP!\nContoh: *${config.prefix}attp Halo Semuanya*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang merender animasi pelangi ATTP...' }, { quoted: msg });

            try {
              const attpWebp = makeAttpSticker(targetText);
              await sock.sendMessage(sender, { sticker: attpWebp }, { quoted: msg });
            } catch (err) {
              console.error('[ATTP Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker ATTP: ' + err.message }, { quoted: msg });
            }
            break;
          }

          // ------------------ FITUR AUDIO: TTS & AUDIO FX ------------------
          case 'tts': {
            const textToSpeak = args.join(' ').trim();
            if (!textToSpeak) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan kalimat yang ingin diucapkan!\nContoh: *${config.prefix}tts Halo selamat pagi semua*` },
                { quoted: msg }
              );
              break;
            }

            try {
              const voiceOgg = await getGoogleTts(textToSpeak, 'id');
              await sock.sendMessage(
                sender,
                { audio: voiceOgg, mimetype: 'audio/ogg; codecs=opus', ptt: true },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[TTS Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat suara TTS: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'bass':
          case 'slow':
          case 'chipmunk':
          case 'robot': {
            let targetAudio = null;
            if (rawMsg.audioMessage) {
              targetAudio = rawMsg.audioMessage;
            } else {
              const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
              if (quoted) {
                const unquoted = unwrapMessage({ message: quoted });
                if (unquoted?.audioMessage) {
                  targetAudio = unquoted.audioMessage;
                }
              }
            }

            if (!targetAudio) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Reply pesan audio atau voice note dengan perintah *${config.prefix}${command}*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: `⏳ Sedang menerapkan efek audio *${command}*...` }, { quoted: msg });

            try {
              const audioBuffer = await getMediaBuffer(targetAudio, 'audio');
              const modifiedOgg = applyAudioEffect(audioBuffer, command);
              await sock.sendMessage(
                sender,
                { audio: modifiedOgg, mimetype: 'audio/ogg; codecs=opus', ptt: true },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[AudioFX Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal memproses efek audio: ' + err.message }, { quoted: msg });
            }
            break;
          }

          // ------------------ FITUR DOWNLOADER & PENCARIAN ------------------
          case 'tt':
          case 'tiktok': {
            const url = args[0] || '';
            if (!url || (!url.includes('tiktok.com') && !url.includes('douyin.com'))) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan link video TikTok yang valid!\nContoh: *${config.prefix}tt https://vt.tiktok.com/xxxxxx/*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang mengunduh video TikTok tanpa watermark...' }, { quoted: msg });

            try {
              const ttData = await getTikTokVideo(url);
              await sock.sendMessage(
                sender,
                {
                  video: { url: ttData.videoUrl },
                  caption: `🎬 *TIKTOK NO WATERMARK*\n\n👤 *Author:* ${ttData.author}\n📝 *Deskripsi:* ${ttData.title}`
                },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[TikTok Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal unduh TikTok: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'pin':
          case 'img':
          case 'pinterest': {
            const query = args.join(' ').trim();
            if (!query) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan kata kunci gambar!\nContoh: *${config.prefix}pin pemandangan anime estetik*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: `🔍 Sedang mencari gambar "${query}"...` }, { quoted: msg });

            try {
              const imgUrl = await searchImage(query);
              await sock.sendMessage(
                sender,
                {
                  image: { url: imgUrl },
                  caption: `🖼️ Hasil pencarian gambar untuk: *${query}*`
                },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[Image Search Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'ssweb':
          case 'screenshot': {
            const url = args[0] || '';
            if (!url) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan alamat URL website!\nContoh: *${config.prefix}ssweb google.com*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang mengambil screenshot website...' }, { quoted: msg });

            try {
              const ssBuffer = await getWebScreenshot(url);
              await sock.sendMessage(
                sender,
                {
                  image: ssBuffer,
                  caption: `📸 Screenshot website: *${url}*`
                },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[SSWeb Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ ' + err.message }, { quoted: msg });
            }
            break;
          }

          // ------------------ FITUR UTILITAS: GEMPA & MENFESS ------------------
          case 'gempa': {
            await sock.sendMessage(sender, { text: '⏳ Mengambil data gempa BMKG terkini...' }, { quoted: msg });

            try {
              const gempa = await getGempaBmkg();
              await sock.sendMessage(
                sender,
                {
                  image: { url: gempa.mapUrl },
                  caption: gempa.caption
                },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[Gempa Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal mengambil data gempa: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'menfess':
          case 'confess': {
            if (args.length < 2) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Format salah!\nContoh: *${config.prefix}menfess 081234567890 Halo, ini dari pengagum rahasiamu!*` },
                { quoted: msg }
              );
              break;
            }

            const rawTarget = args[0];
            const pesanMenfess = args.slice(1).join(' ').trim();

            if (!rawTarget || !pesanMenfess) {
              await sock.sendMessage(
                sender,
                { text: '⚠️ Nomor tujuan atau isi pesan menfess tidak valid!' },
                { quoted: msg }
              );
              break;
            }

            const check = await validateAndResolveJid(sock, rawTarget);
            if (!check.valid) {
              await sock.sendMessage(
                sender,
                { text: `❌ ${check.error}` },
                { quoted: msg }
              );
              break;
            }

            const targetJid = check.jid;

            try {
              const menfessText =
                `💌 *PESAN MENFESS RAHASIA* 💌\n\n` +
                `Ada seseorang yang menitipkan pesan rahasia untuk kamu:\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `"${pesanMenfess}"\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `_Pesan ini dikirimkan secara anonim melalui bot._`;

              await sock.sendMessage(targetJid, { text: menfessText });
              await sock.sendMessage(
                sender,
                { text: `✅ Pesan menfess rahasia berhasil dikirimkan ke target!` },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[Menfess Error]:', err.message);
              await sock.sendMessage(
                sender,
                { text: `❌ Gagal mengirim menfess: ${err.message}` },
                { quoted: msg }
              );
            }
            break;
          }

          // ------------------ FITUR GAME: TEBAK KATA ------------------
          case 'tebakkata': {
            if (activeGames.has(sender)) {
              await sock.sendMessage(
                sender,
                { text: '⚠️ Masih ada permainan yang sedang berlangsung di chat ini! Jawab dulu atau tunggu waktu habis.' },
                { quoted: msg }
              );
              break;
            }

            const q = getRandomTebakKata();
            const timer = setTimeout(async () => {
              if (activeGames.has(sender)) {
                const game = activeGames.get(sender);
                activeGames.delete(sender);
                try {
                  await sock.sendMessage(sender, {
                    text: `⌛ *WAKTU HABIS!* \nJawaban tebak kata sebelumnya adalah: *${game.answer.toUpperCase()}*`
                  });
                } catch {}
              }
            }, 60000);

            activeGames.set(sender, {
              answer: q.jawaban.toLowerCase().trim(),
              timer
            });

            await sock.sendMessage(
              sender,
              {
                text:
                  `🎮 *TEBAK KATA* 🎮\n\n` +
                  `❓ *Pertanyaan:* ${q.soal}\n` +
                  `💡 *Petunjuk:* \`${q.clue}\`\n\n` +
                  `⏱️ *Waktu:* 60 detik\n` +
                  `_Ketik jawaban kamu langsung di chat ini!_`
              },
              { quoted: msg }
            );
            break;
          }

          case 's':
          case 'sticker': {
            let targetImage = null;
            if (rawMsg.imageMessage) {
              targetImage = rawMsg.imageMessage;
            } else {
              const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
              if (quoted) {
                const unquoted = unwrapMessage({ message: quoted });
                if (unquoted?.imageMessage) {
                  targetImage = unquoted.imageMessage;
                }
              }
            }

            if (!targetImage) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Kirim foto dengan caption *${config.prefix}s* atau reply foto dengan *${config.prefix}s*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang membuat stiker...' }, { quoted: msg });
            const buffer = await getMediaBuffer(targetImage, 'image');
            const stickerWebp = await makeSticker(buffer);

            await sock.sendMessage(sender, { sticker: stickerWebp }, { quoted: msg });
            break;
          }

          case 'toimg': {
            let targetSticker = null;
            const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
              const unquoted = unwrapMessage({ message: quoted });
              if (unquoted?.stickerMessage) {
                targetSticker = unquoted.stickerMessage;
              }
            }

            if (!targetSticker) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Reply stiker yang ingin diubah menjadi gambar dengan perintah *${config.prefix}toimg*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Mengonversi stiker ke gambar...' }, { quoted: msg });
            const stickerBuf = await getMediaBuffer(targetSticker, 'sticker');
            const imgBuffer = await stickerToImage(stickerBuf);

            await sock.sendMessage(
              sender,
              { image: imgBuffer, caption: '✅ Stiker berhasil dikonversi ke gambar!' },
              { quoted: msg }
            );
            break;
          }

          case 'hd':
          case 'remini': {
            let targetImage = null;
            if (rawMsg.imageMessage) {
              targetImage = rawMsg.imageMessage;
            } else {
              const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
              if (quoted) {
                const unquoted = unwrapMessage({ message: quoted });
                if (unquoted?.imageMessage) {
                  targetImage = unquoted.imageMessage;
                }
              }
            }

            if (!targetImage) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Kirim foto dengan caption *${config.prefix}hd* atau reply foto dengan *${config.prefix}hd*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang memperjelas & upscaling foto dengan AI...' }, { quoted: msg });
            const buffer = await getMediaBuffer(targetImage, 'image');
            const hdBuffer = await upscaleImage(buffer);

            await sock.sendMessage(
              sender,
              {
                image: hdBuffer,
                caption: '✨ Foto berhasil di-upscale ke kualitas HD!'
              },
              { quoted: msg }
            );
            break;
          }

          case 'ai':
          case 'ask':
          case 'tanya': {
            const prompt = args.join(' ').trim();
            if (!prompt) {
              await sock.sendMessage(
                sender,
                {
                  text: '🤖 *Tanya AI (Dengan Memori)*\n\n' +
                        'Bot mengingat percakapan sebelumnya dalam sesi Anda.\n\n' +
                        'Contoh:\n' +
                        '• *.ai halo, nama saya Fatih*\n' +
                        '• *.ai siapa nama saya?*\n' +
                        '• *.ai reset* (atau *.resetai* untuk menghapus ingatan)'
                },
                { quoted: msg }
              );
              break;
            }

            if (prompt.toLowerCase() === 'reset' || prompt.toLowerCase() === 'clear') {
              aiChatSessions.delete(userKey);
              await sock.sendMessage(
                sender,
                {
                  text: '🧹 *Memori AI Berhasil Direset!*\n\nRiwayat percakapan sebelumnya telah dihapus. Kamu bisa memulai obrolan baru.'
                },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '💭 Sedang berpikir...' }, { quoted: msg });

            // Ambil sesi memori user
            const session = aiChatSessions.get(userKey) || { history: [], lastActive: Date.now() };
            session.lastActive = Date.now();

            try {
              const persona = aiSettings.get(userKey)?.persona || '';
              const answer = await askAI(prompt, session.history, userKey, persona);

              // Simpan giliran obrolan ke riwayat memori (maksimal 10 pesan terakhir)
              session.history.push({ role: 'user', content: prompt });
              session.history.push({ role: 'assistant', content: answer });
              if (session.history.length > 10) {
                session.history = session.history.slice(-10);
              }
              aiChatSessions.set(userKey, session);

              await sock.sendMessage(
                sender,
                {
                  text: `🤖 *Jawaban AI:*\n\n${answer}\n\n_💡 Ketik *.ai reset* untuk menghapus ingatan obrolan._`
                },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[AI Handler Error]:', err.message);
              await sock.sendMessage(
                sender,
                { text: `⚠️ ${err.message || 'Gagal menghubungi server AI.'}` },
                { quoted: msg }
              );
            }
            break;
          }

          case 'persona':
          case 'setpersona':
          case 'mypersona': {
            const personaText = args.join(' ').trim();
            const lowerPersona = personaText.toLowerCase();
            if (!personaText || ['lihat', 'show', 'info'].includes(lowerPersona)) {
              const currentPersona = aiSettings.get(userKey)?.persona;
              await sock.sendMessage(sender, {
                text: currentPersona
                  ? `🎭 *Persona AI kamu:*\n${currentPersona}\n\nUbah: *.persona <deskripsi karakter>*\nHapus: *.persona reset*`
                  : `🎭 Belum ada persona khusus.\nPakai *.persona <deskripsi karakter>* untuk mengatur, misalnya: *.persona guru yang sabar, jawab ringkas dalam Bahasa Indonesia*.\n\nKamu juga bisa reply pesan berisi deskripsi persona dengan *.persona*.`
              }, { quoted: msg });
              break;
            }
            if (['reset', 'hapus', 'clear', 'default'].includes(lowerPersona)) {
              const settings = aiSettings.get(userKey) || {};
              delete settings.persona;
              if (Object.keys(settings).length) aiSettings.set(userKey, settings);
              else aiSettings.delete(userKey);
              saveAiSettings();
              aiChatSessions.delete(userKey);
              await sock.sendMessage(sender, { text: '✅ Persona khusus dihapus. AI kembali ke persona bawaan. Memori obrolan juga direset.' }, { quoted: msg });
              break;
            }
            if (personaText.length > 500) {
              await sock.sendMessage(sender, { text: '⚠️ Deskripsi persona maksimal 500 karakter.' }, { quoted: msg });
              break;
            }
            const settings = aiSettings.get(userKey) || {};
            settings.persona = personaText;
            aiSettings.set(userKey, settings);
            saveAiSettings();
            aiChatSessions.delete(userKey);
            await sock.sendMessage(sender, { text: `✅ Persona AI tersimpan untuk kamu:\n🎭 ${personaText}\n\nMemori AI direset supaya persona baru langsung berlaku. Coba lanjut dengan *.ai halo*.` }, { quoted: msg });
            break;
          }

          case 'resetai':
          case 'cleari': {
            aiChatSessions.delete(userKey);
            await sock.sendMessage(
              sender,
              {
                text: '🧹 *Memori AI Berhasil Direset!*\n\nRiwayat percakapan sebelumnya telah dihapus. Kamu bisa memulai percakapan baru dengan *.ai*.'
              },
              { quoted: msg }
            );
            break;
          }


          // ------------------ TOOLS & UTILITAS ------------------
          case 'qr':
          case 'qrcode': {
            const text = args.join(' ');
            if (!text) {
              await sock.sendMessage(sender, { text: '⚠️ Masukkan teks atau URL. Contoh: .qr https://google.com' }, { quoted: msg });
              break;
            }
            await sock.sendMessage(sender, { text: '⏳ Sedang membuat QR Code...' }, { quoted: msg });
            const qrBuf = await generateQrBuffer(text);
            await sock.sendMessage(sender, { image: qrBuf, caption: `✅ QR Code untuk:\n"${text}"` }, { quoted: msg });
            break;
          }

          case 'tr':
          case 'translate': {
            if (args.length === 0) {
              await sock.sendMessage(sender, {
                text: '⚠️ Format: .tr [kode_bahasa] <teks>\nBalas sebuah pesan lalu ketik *.tr* untuk menerjemahkannya ke Bahasa Indonesia.\nContoh: *.tr en selamat pagi* atau reply teks dengan *.tr en*.'
              }, { quoted: msg });
              break;
            }
            const languageAliases = new Set(['id', 'en', 'ja', 'ko', 'zh', 'cn', 'ar', 'de', 'fr', 'es', 'ru', 'jp', 'eng', 'english', 'inggris', 'indo', 'indonesia', 'jepang', 'korea', 'mandarin', 'arabic', 'arab', 'jerman', 'prancis', 'spanyol', 'rusia']);
            for (const code of ['af','sq','am','hy','az','eu','be','bn','bs','bg','my','ca','ceb','ny','zh-cn','zh-tw','co','hr','cs','da','nl','eo','et','tl','fi','fy','gl','ka','el','gu','ht','ha','haw','he','hi','hmn','hu','is','ig','ga','it','jw','kk','km','kn','ku','ky','lo','la','lv','lt','lb','mk','mg','ms','ml','mt','mi','mr','mn','ne','no','ps','fa','pl','pt','pa','ro','sm','gd','sr','st','sn','sd','si','sk','sl','so','su','sw','sv','tg','ta','te','th','tr','uk','ur','uz','vi','cy','xh','yi','yo','zu']) languageAliases.add(code);
            let targetLang = 'id';
            let text = args.join(' ').trim();
            const firstArg = String(args[0] || '').toLowerCase();
            if (languageAliases.has(firstArg) || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(firstArg)) {
              targetLang = firstArg;
              text = args.slice(1).join(' ').trim() || quotedText;
            }
            if (!text) {
              await sock.sendMessage(sender, { text: '⚠️ Tidak ada teks yang bisa diterjemahkan. Sertakan teks atau reply pesan, lalu ketik *.tr*.' }, { quoted: msg });
              break;
            }
            const translated = await translateText(text, targetLang);
            await sock.sendMessage(sender, { text: `🌐 *Terjemahan (${targetLang.toUpperCase()}):*\n\n${translated}` }, { quoted: msg });
            break;
          }

          case 'wiki':
          case 'wikipedia': {
            const q = args.join(' ');
            if (!q) {
              await sock.sendMessage(sender, { text: '⚠️ Masukkan topik yang ingin dicari. Contoh: .wiki Indonesia' }, { quoted: msg });
              break;
            }
            await sock.sendMessage(sender, { text: '🔍 Mencari di Wikipedia...' }, { quoted: msg });
            const info = await getWikiSummary(q);
            const caption = `📚 *${info.title}*\n\n${info.extract}\n\n_Sumber: Wikipedia Indonesia_`;
            if (info.thumbnail) {
              await sock.sendMessage(sender, { image: { url: info.thumbnail }, caption }, { quoted: msg });
            } else {
              await sock.sendMessage(sender, { text: caption }, { quoted: msg });
            }
            break;
          }

          case 'short':
          case 'shortlink': {
            const url = args[0];
            if (!url || !url.startsWith('http')) {
              await sock.sendMessage(sender, { text: '⚠️ Masukkan URL valid diawali http:// atau https://\nContoh: .short https://google.com' }, { quoted: msg });
              break;
            }
            const tiny = await shortenUrl(url);
            await sock.sendMessage(sender, { text: `🔗 *Shortlink Berhasil:*\n${tiny}` }, { quoted: msg });
            break;
          }

          case 'cuaca':
          case 'weather': {
            const kota = args.join(' ') || 'Jakarta';
            await sock.sendMessage(sender, { text: `⏳ Memeriksa cuaca di ${kota}...` }, { quoted: msg });
            const res = await getWeather(kota);
            await sock.sendMessage(sender, { text: `🌤️ *Laporan Cuaca:*\n${res}` }, { quoted: msg });
            break;
          }

          case 'calc': {
            const expression = args.join(' ');
            if (!expression || !/^[0-9+\-*/().\s]+$/.test(expression)) {
              await sock.sendMessage(sender, { text: '⚠️ Masukkan operasi matematika valid. Contoh: .calc 100 * 25' }, { quoted: msg });
              break;
            }
            try {
              const result = Function(`'use strict'; return (${expression})`)();
              await sock.sendMessage(sender, { text: `🔢 *Hasil:* ${expression} = *${result}*` }, { quoted: msg });
            } catch {
              await sock.sendMessage(sender, { text: '⚠️ Format kalkulasi salah!' }, { quoted: msg });
            }
            break;
          }

          // ------------------ ISLAMI ------------------
          case 'sholat':
          case 'jadwalsholat': {
            const kota = args.join(' ') || 'Jakarta';
            await sock.sendMessage(sender, { text: `⏳ Mengambil jadwal sholat untuk ${kota}...` }, { quoted: msg });
            const j = await getJadwalSholat(kota);
            const text = `🕌 *Jadwal Sholat - ${j.kota}*\n📅 ${j.tanggal}\n\n` +
              `• Imsak   : ${j.imsak}\n` +
              `• Subuh   : ${j.subuh}\n` +
              `• Terbit  : ${j.terbit}\n` +
              `• Dhuha   : ${j.dhuha}\n` +
              `• Dzuhur  : ${j.dzuhur}\n` +
              `• Ashar   : ${j.ashar}\n` +
              `• Maghrib : ${j.maghrib}\n` +
              `• Isya    : ${j.isya}\n\n` +
              `_Waktu setempat (WIB/WITA/WIT)_`;
            await sock.sendMessage(sender, { text }, { quoted: msg });
            break;
          }

          case 'surah':
          case 'quran': {
            const nomor = parseInt(args[0], 10);
            if (!nomor || nomor < 1 || nomor > 114) {
              await sock.sendMessage(sender, { text: '⚠️ Masukkan nomor surah (1 - 114). Contoh: .surah 1' }, { quoted: msg });
              break;
            }
            const s = await getSurah(nomor);
            const text = `📖 *Surah ${s.namaLatin} (${s.nama})*\n` +
              `• Arti: *${s.arti}*\n` +
              `• Jumlah Ayat: ${s.jumlahAyat}\n` +
              `• Tempat Turun: ${s.tempatTurun}\n\n` +
              `*Deskripsi:*\n${s.deskripsi.slice(0, 450)}...`;
            await sock.sendMessage(sender, { text }, { quoted: msg });
            break;
          }

          // ------------------ GAME & HIBURAN ------------------
          case 'dadu': {
            const diceEmojis = ['⚀ 1', '⚁ 2', '⚂ 3', '⚃ 4', '⚄ 5', '⚅ 6'];
            const roll = diceEmojis[Math.floor(Math.random() * diceEmojis.length)];
            await sock.sendMessage(sender, { text: `🎲 Dadu dilempar dan hasilnya: *${roll}*` }, { quoted: msg });
            break;
          }

          case 'koin': {
            const sides = ['🪙 GAMBAR', '🪙 ANGKA'];
            const pick = sides[Math.floor(Math.random() * sides.length)];
            await sock.sendMessage(sender, { text: `Lemparan koin mendarat di: *${pick}*!` }, { quoted: msg });
            break;
          }

          case 'apakah': {
            const q = args.join(' ');
            if (!q) {
              await sock.sendMessage(sender, { text: 'Contoh: .apakah besok bakal hujan?' }, { quoted: msg });
              break;
            }
            const answers = [
              'Iya, pasti!',
              'Tidak mungkin.',
              'Bisa jadi sih.',
              'Kayaknya enggak deh.',
              'Tentu saja!',
              'Coba tanya lagi nanti ya.',
              'Peluangnya 50:50.',
              'Sangat meragukan.'
            ];
            const pick = answers[Math.floor(Math.random() * answers.length)];
            await sock.sendMessage(sender, { text: `🎱 *Pertanyaan:* Apakah ${q}?\n*Jawaban:* ${pick}` }, { quoted: msg });
            break;
          }

          case 'siapakah': {
            const groupJid = msg.key.remoteJid;
            if (!groupJid?.endsWith('@g.us')) {
              await sock.sendMessage(sender, { text: 'Perintah ini hanya bisa dipakai di dalam grup.' }, { quoted: msg });
              break;
            }
            const metadata = await sock.groupMetadata(groupJid);
            const participants = metadata.participants;
            if (!participants || participants.length === 0) break;
            const randomMember = participants[Math.floor(Math.random() * participants.length)];
            const q = args.join(' ') || 'yang paling keren';
            await sock.sendMessage(
              groupJid,
              {
                text: `Pertanyaan: *Siapakah ${q}?*\n\nJawaban bot: @${randomMember.id.split('@')[0]}! 😎`,
                mentions: [randomMember.id]
              },
              { quoted: msg }
            );
            break;
          }

          case 'rate': {
            const target = args.join(' ');
            if (!target) {
              await sock.sendMessage(sender, { text: 'Contoh: .rate seberapa jago bermain game' }, { quoted: msg });
              break;
            }
            const score = Math.floor(Math.random() * 101);
            await sock.sendMessage(sender, { text: `📊 *Penilaian:* "${target}"\n*Skor:* ${score}%` }, { quoted: msg });
            break;
          }

          // ------------------ GRUP ADMIN ------------------
          case 'kick':
          case 'remove':
          case 'promote':
          case 'demote':
          case 'mute':
          case 'unmute':
          case 'tagall':
          case 'hidetag':
          case 'linkgroup':
          case 'linkgc':
          case 'setname':
          case 'setdesc':
          case 'groupinfo': {
            const ctx = await getGroupAdminContext(sock, msg);
            if (ctx.error) {
              await sock.sendMessage(sender, { text: `⛔ ${ctx.error}` }, { quoted: msg });
              break;
            }

            if (command === 'groupinfo') {
              const admins = ctx.metadata.participants.filter((p) => ['admin', 'superadmin'].includes(p.admin));
              await sock.sendMessage(sender, { text: `📋 *${ctx.metadata.subject}*\n• ID: ${ctx.groupJid}\n• Anggota: ${ctx.metadata.participants.length}\n• Admin: ${admins.length}` }, { quoted: msg });
              break;
            }

            if (command === 'linkgroup' || command === 'linkgc') {
              const code = await sock.groupInviteCode(ctx.groupJid);
              await sock.sendMessage(sender, { text: `🔗 *Tautan Undangan Grup:*\nhttps://chat.whatsapp.com/${code}` }, { quoted: msg });
              break;
            }

            if (command === 'setname') {
              const newName = args.join(' ');
              if (!newName) {
                await sock.sendMessage(sender, { text: '⚠️ Masukkan nama baru grup. Contoh: .setname Grup Keren' }, { quoted: msg });
                break;
              }
              await sock.groupUpdateSubject(ctx.groupJid, newName);
              await sock.sendMessage(sender, { text: `✅ Berhasil mengganti nama grup menjadi: *${newName}*` }, { quoted: msg });
              break;
            }

            if (command === 'setdesc') {
              const newDesc = args.join(' ');
              await sock.groupUpdateDescription(ctx.groupJid, newDesc);
              await sock.sendMessage(sender, { text: `✅ Berhasil memperbarui deskripsi grup!` }, { quoted: msg });
              break;
            }

            if (command === 'mute' || command === 'unmute') {
              await sock.groupSettingUpdate(ctx.groupJid, command === 'mute' ? 'announcement' : 'not_announcement');
              await sock.sendMessage(sender, { text: command === 'mute' ? '🔇 Grup kini hanya bisa dikirim pesan oleh admin.' : '🔊 Grup dibuka kembali untuk semua anggota.' }, { quoted: msg });
              break;
            }

            if (command === 'tagall') {
              const mentions = ctx.metadata.participants.map((p) => p.id);
              const text = args.join(' ') || 'Pemberitahuan untuk semua anggota';
              await sock.sendMessage(ctx.groupJid, { text: `📢 ${text}`, mentions }, { quoted: msg });
              break;
            }

            if (command === 'hidetag') {
              const mentions = ctx.metadata.participants.map((p) => p.id);
              const text = args.join(' ') || 'Halo semua 👋';
              await sock.sendMessage(ctx.groupJid, { text, mentions });
              break;
            }

            const targets = getMentionedJids(msg);
            const target = targets[0] || getQuotedParticipant(msg);
            if (!target) {
              await sock.sendMessage(sender, { text: `Gunakan dengan mention atau reply anggota. Contoh: .${command} @anggota` }, { quoted: msg });
              break;
            }
            if (target === ctx.botJid || target === ctx.senderJid) {
              await sock.sendMessage(sender, { text: '⛔ Bot tidak akan mengubah peran atau mengeluarkan dirinya/pengirim perintah.' }, { quoted: msg });
              break;
            }
            if (command === 'kick' || command === 'remove') {
              await sock.groupParticipantsUpdate(ctx.groupJid, [target], 'remove');
            } else {
              await sock.groupParticipantsUpdate(ctx.groupJid, [target], command);
            }
            await sock.sendMessage(sender, { text: `✅ Perintah *${command}* diproses untuk @${target.split('@')[0]}.`, mentions: [target] }, { quoted: msg });
            break;
          }

          // ------------------ INFORMASI BOT ------------------
          case 'ping': {
            const start = Date.now();
            await sock.sendMessage(sender, { text: `Pong! 🏓 (${Date.now() - start} ms)` }, { quoted: msg });
            break;
          }

          case 'owner': {
            await sock.sendMessage(
              sender,
              { text: `Owner bot ini dapat dihubungi di: wa.me/${config.ownerNumber}` },
              { quoted: msg }
            );
            break;
          }

          case 'runtime': {
            const uptimeSec = Math.floor(process.uptime());
            const hours = Math.floor(uptimeSec / 3600);
            const minutes = Math.floor((uptimeSec % 3600) / 60);
            const seconds = uptimeSec % 60;
            await sock.sendMessage(
              sender,
              { text: `⏱️ Bot sudah aktif selama: ${hours} jam, ${minutes} menit, ${seconds} detik` },
              { quoted: msg }
            );
            break;
          }

          default:
            break;
        }
      } catch (err) {
        console.error('Error saat menjalankan perintah:', err);
        await sock.sendMessage(
          sender,
          { text: '❌ Terjadi kesalahan saat memproses perintah: ' + err.message },
          { quoted: msg }
        );
      } finally {
        await sock.sendPresenceUpdate('paused', sender);
      }
}

function setupAutoBashIntegration() {
  const sendJsPath = path.resolve(__dirname, 'send.js');
  const sendBinPath = path.resolve(__dirname, 'send');

  try { fs.chmodSync(sendBinPath, 0o755); } catch {}
  try { fs.chmodSync(sendJsPath, 0o755); } catch {}

  // 1. Pasang di node_modules/.bin/send (karena container Node sering masukkan ini ke PATH)
  try {
    const nmBin = path.resolve(__dirname, 'node_modules', '.bin');
    fs.mkdirSync(nmBin, { recursive: true });
    const nmSend = path.join(nmBin, 'send');
    if (!fs.existsSync(nmSend)) {
      try {
        fs.symlinkSync(sendBinPath, nmSend);
      } catch {
        fs.copyFileSync(sendBinPath, nmSend);
      }
    }
    try { fs.chmodSync(nmSend, 0o755); } catch {}
  } catch {}

  // 2. Coba pasang di /usr/local/bin/send (jika container mengizinkan write)
  try {
    const usrSend = '/usr/local/bin/send';
    if (!fs.existsSync(usrSend)) {
      try {
        fs.symlinkSync(sendBinPath, usrSend);
      } catch {
        fs.copyFileSync(sendBinPath, usrSend);
      }
      try { fs.chmodSync(usrSend, 0o755); } catch {}
    }
  } catch {}

  // 3. Tambahkan alias di ~/.bashrc dan /home/container/.bashrc
  const homeDirs = [process.env.HOME, '/home/container', '/root'].filter(Boolean);
  for (const h of homeDirs) {
    try {
      const bashrc = path.join(h, '.bashrc');
      if (fs.existsSync(bashrc)) {
        let rc = fs.readFileSync(bashrc, 'utf-8');
        if (!rc.includes('alias send=') && !rc.includes('send()')) {
          rc += `\nalias send="node ${sendJsPath}"\nexport PATH="$PATH:${path.dirname(sendJsPath)}:${path.resolve(__dirname, 'node_modules', '.bin')}"\n`;
          fs.writeFileSync(bashrc, rc, 'utf-8');
        }
      }
    } catch {}
  }
}


const KNOWN_COMMANDS = new Set([
  "menu", "help", "brat", "bratwhite", "bratvid", "bratvideo", "bratgif", "bratv",
  "qc", "smeme", "ttp", "attp", "tts", "bass", "slow", "chipmunk", "robot",
  "tt", "tiktok", "pin", "img", "pinterest", "ssweb", "screenshot", "gempa",
  "menfess", "confess", "tebakkata", "s", "sticker", "toimg", "hd", "remini",
  "ai", "ask", "tanya", "persona", "setpersona", "mypersona", "resetai", "cleari",
  "qr", "qrcode", "tr", "translate", "wiki", "wikipedia", "short", "shortlink",
  "cuaca", "weather", "calc", "sholat", "jadwalsholat", "surah", "quran",
  "dadu", "koin", "apakah", "siapakah", "rate", "kick", "remove", "promote",
  "demote", "mute", "unmute", "tagall", "hidetag", "linkgroup", "linkgc",
  "setname", "setdesc", "groupinfo", "ping", "owner", "runtime"
]);

function createMessageCaptureSocket(sock) {
  const capturedReplies = [];
  const handler = {
    get(target, prop, receiver) {
      if (prop === "sendMessage") {
        return async (dest, content, options) => {
          const res = await target.sendMessage(dest, content, options);
          if (res?.key?.id && res?.message) {
            storeMessage(res.key.id, res.message);
          }
          let summary = "";
          if (typeof content === "string") {
            summary = content;
          } else if (content?.text) {
            summary = content.text;
          } else if (content?.caption) {
            summary = content.caption;
          } else if (content?.sticker) {
            summary = "[Stiker WebP terkirim ke WhatsApp]";
          } else if (content?.image) {
            summary = "[Foto/Gambar terkirim ke WhatsApp]";
          } else if (content?.video) {
            summary = "[Video terkirim ke WhatsApp]";
          } else if (content?.audio) {
            summary = "[Audio/Voice Note terkirim ke WhatsApp]";
          } else {
            summary = "[Media terkirim ke WhatsApp]";
          }
          if (summary) capturedReplies.push(summary);
          return res;
        };
      }
      const val = Reflect.get(target, prop, target);
      if (typeof val === "function") {
        return val.bind(target);
      }
      return val;
    }
  };
  return {
    wrapped: new Proxy(sock, handler),
    capturedReplies
  };
}

function getMeaningfulReply(replies) {
  if (!replies || replies.length === 0) return "";
  if (replies.length === 1) return replies[0];
  const filtered = replies.filter(r => {
    const trimmed = (r || "").trim();
    return !trimmed.startsWith("💭 Sedang berpikir") &&
           !trimmed.startsWith("⏳ Sedang") &&
           !trimmed.startsWith("⏳ Mohon tunggu");
  });
  if (filtered.length > 0) {
    return filtered.join("\n\n");
  }
  return replies.join("\n\n");
}

function setupConsoleCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) return;

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'help' || cmd === 'menu') {
      console.log('\n================== PANDUAN CONSOLE BOT-HOSTING ==================');
      console.log('1. Kirim pesan ke nomor/grup WhatsApp:');
      console.log('   send <nomor/grup> <pesan>');
      console.log('   Contoh: send 081234567890 Halo dari console panel!');
      console.log('   Contoh: send 1203630234567890@g.us Halo semua anggota grup!');
      console.log('   Contoh: send me Ini catatan buat nomor bot sendiri');
      console.log('   Contoh: send owner Halo owner!');
      console.log('2. Shortcut cepat (langsung ketik nomor lalu pesan):');
      console.log('   081234567890 Halo apa kabar?');
      console.log('3. Cek status & pemakaian RAM container:');
      console.log('   status');
      console.log('4. Eksekusi kode JS (debug):');
      console.log('   eval <kode>');
      console.log('5. Tampilkan bantuan ini:');
      console.log('   help');
      console.log('===================================================================\n');
      return;
    }

    if (cmd === 'status') {
      const isConnected = !!(currentSock && currentSock.user);
      const botNum = currentSock?.user?.id ? currentSock.user.id.split(':')[0] : 'Belum login';
      const uptimeSec = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const memRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const memHeap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`[Status Console] Terhubung: ${isConnected ? 'YA (Aktif)' : 'TIDAK'} | Nomor: ${botNum} | Uptime: ${hours}j ${mins}m | RAM: ${memRss}MB (Heap: ${memHeap}MB)`);
      return;
    }

    if (cmd === 'eval') {
      const code = parts.slice(1).join(' ').trim();
      if (!code) {
        console.log('⚠️ [Console] Masukkan kode JavaScript untuk di-eval.');
        return;
      }
      try {
        const result = eval(code);
        console.log('➡️ [Eval Result]:', result);
      } catch (err) {
        console.error('❌ [Eval Error]:', err.message);
      }
      return;
    }

    if (!currentSock || !currentSock.user) {
      console.log('⚠️ [Console] Bot belum terhubung ke WhatsApp. Tunggu hingga login selesai atau scan QR.');
      return;
    }

    let targetRaw = '';
    let messageText = '';

    if (['send', 'kirim', 'msg', 'say'].includes(cmd)) {
      targetRaw = parts[1];
      messageText = parts.slice(2).join(' ').trim();
    } else if (cmd === 'me' || cmd === 'self') {
      targetRaw = 'me';
      messageText = parts.slice(1).join(' ').trim();
    } else if (cmd === 'owner') {
      targetRaw = 'owner';
      messageText = parts.slice(1).join(' ').trim();
    } else if (parts[0].match(/^(08|62|\+62|[0-9]{8,20}|.*@g\.us|.*@s\.whatsapp\.net|.*@lid)/i)) {
      targetRaw = parts[0];
      messageText = parts.slice(1).join(' ').trim();
    } else {
      console.log(`⚠️ [Console] Perintah "${cmd}" tidak dikenal. Ketik "help" untuk bantuan.`);
      return;
    }

    if (!targetRaw || !messageText) {
      console.log('⚠️ [Console] Format salah. Contoh: send 081234567890 Halo ini pesan dari console');
      return;
    }

    if (!currentSock || !currentSock.user) {
      console.log('⚠️ [Console] Bot belum login atau belum terhubung ke WhatsApp.');
      return;
    }

    console.log(`🔍 [Console] Memeriksa status nomor ${targetRaw} di server WhatsApp...`);
    const check = await validateAndResolveJid(currentSock, targetRaw);
    if (!check.valid) {
      console.log(`❌ [Console Ditolak] ${check.error}`);
      return;
    }

    const jid = check.jid;

    const destDesc = check.isSelf ? `nomor sendiri / self chat (${jid})` : jid;

    try {
      console.log(`⏳ [Console] Mengirim pesan ke ${destDesc}...`);
      const sent = await currentSock.sendMessage(jid, { text: messageText });
      if (sent?.key?.id && sent?.message) {
        storeMessage(sent.key.id, sent.message);
      }
      console.log(`✅ [Console Sukses] Pesan terkirim ke ${destDesc}: "${messageText}"`);

      // Jika pesan adalah command bot (.menu, .ping, dll), eksekusi otomatis
      let isCmd = messageText.startsWith(config.prefix);
      let cmdName = "";
      if (isCmd) {
        cmdName = messageText.slice(config.prefix.length).trim().split(/\s+/)[0].toLowerCase();
      } else {
        const firstWord = messageText.trim().split(/\s+/)[0].toLowerCase();
        if (KNOWN_COMMANDS.has(firstWord)) {
          isCmd = true;
          cmdName = firstWord;
          messageText = config.prefix + messageText.trim();
        }
      }

      if (isCmd) {
        console.log(`⚙️ [Console Command] Menjalankan perintah "${messageText}" untuk ${destDesc}...`);
        const capture = createMessageCaptureSocket(currentSock);
        try {
          await handleBotCommand(capture.wrapped, {
            sender: jid,
            bodyText: messageText,
            msg: sent,
            rawMsg: unwrapMessage(sent),
            isFromMe: true,
            userKey: currentSock.user?.id || jid,
            isConsole: true
          });
          const replyText = getMeaningfulReply(capture.capturedReplies);
          if (replyText) {
            console.log(`\n${cmdName}: ${replyText}\n`);
          }
        } catch (err) {
          console.error(`❌ [Console Command Error]:`, err.message);
        }
      }
    } catch (err) {
      console.error(`❌ [Console Gagal] Tidak dapat mengirim pesan ke ${destDesc}:`, err.message);
    }
  });

  rl.on('error', (err) => {
    console.error('[Console CLI Error]:', err.message);
  });

  // Jalankan integrasi bash terminal otomatis
  setupAutoBashIntegration();

  // HTTP IPC Server pada 127.0.0.1:45678 untuk menerima perintah send dari bash terminal
  try {
    const ipcServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1:45678');
      if (url.pathname === '/send') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          let targetRaw = url.searchParams.get('to') || url.searchParams.get('target');
          let messageText = url.searchParams.get('msg') || url.searchParams.get('message') || url.searchParams.get('text');

          if (body) {
            try {
              const parsed = JSON.parse(body);
              targetRaw = parsed.target || parsed.to || targetRaw;
              messageText = parsed.message || parsed.msg || parsed.text || messageText;
            } catch {}
          }

          if (!targetRaw || !messageText) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Target nomor dan pesan wajib diisi.' }));
          }

          if (!currentSock || !currentSock.user) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Bot belum login atau belum terhubung ke WhatsApp.' }));
          }

          console.log(`🔍 [Terminal/CLI] Memeriksa status nomor ${targetRaw} di server WhatsApp...`);
          const check = await validateAndResolveJid(currentSock, targetRaw);
          if (!check.valid) {
            console.log(`❌ [Terminal/CLI Ditolak] ${check.error}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: check.error }));
          }

          const jid = check.jid;

          const destDesc = check.isSelf ? `nomor sendiri / self chat (${jid})` : jid;

          try {
            console.log(`⏳ [Terminal/CLI] Mengirim pesan ke ${destDesc}...`);
            const sent = await currentSock.sendMessage(jid, { text: messageText });
            if (sent?.key?.id && sent?.message) {
              storeMessage(sent.key.id, sent.message);
            }
            console.log(`✅ [Terminal/CLI Sukses] Pesan terkirim ke ${destDesc}: "${messageText}"`);

            let isCmd = messageText.startsWith(config.prefix);
            let cmdName = "";
            if (isCmd) {
              cmdName = messageText.slice(config.prefix.length).trim().split(/\s+/)[0].toLowerCase();
            } else {
              const firstWord = messageText.trim().split(/\s+/)[0].toLowerCase();
              if (KNOWN_COMMANDS.has(firstWord)) {
                isCmd = true;
                cmdName = firstWord;
                messageText = config.prefix + messageText.trim();
              }
            }

            let replyText = "";
            let capturedReplies = [];

            if (isCmd) {
              console.log(`⚙️ [Terminal Command] Menjalankan perintah "${messageText}" untuk ${destDesc}...`);
              const capture = createMessageCaptureSocket(currentSock);
              try {
                await handleBotCommand(capture.wrapped, {
                  sender: jid,
                  bodyText: messageText,
                  msg: sent,
                  rawMsg: unwrapMessage(sent),
                  isFromMe: true,
                  userKey: currentSock.user?.id || jid,
                  isConsole: true
                });
                capturedReplies = capture.capturedReplies;
                replyText = getMeaningfulReply(capturedReplies);
                if (replyText) {
                  console.log(`💬 [Console Output ${cmdName}]:\n${cmdName}: ${replyText}`);
                }
              } catch (err) {
                console.error(`❌ [Terminal Command Error]:`, err.message);
                replyText = `❌ Error: ${err.message}`;
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              jid,
              message: messageText,
              isSelf: check.isSelf,
              isCommand: isCmd,
              command: cmdName,
              replyText: replyText,
              replies: capturedReplies
            }));
          } catch (err) {
            console.error(`❌ [Terminal/CLI Gagal] Gagal kirim ke ${destDesc}:`, err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }

      if (url.pathname === '/status') {
        const isConnected = !!(currentSock && currentSock.user);
        const botNum = currentSock?.user?.id ? currentSock.user.id.split(':')[0] : 'Belum login';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ connected: isConnected, number: botNum, uptime: process.uptime() }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint tidak ditemukan' }));
    });

    ipcServer.listen(45678, '127.0.0.1', () => {});
    ipcServer.on('error', () => {});
  } catch {}

}

async function startBot() {
  const sessionDir = path.resolve('./session');
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(sessionDir, 0o700); } catch {}
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`Menghubungkan WhatsApp Bot v${version.join('.')}...`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    msgRetryCounterCache,
    getMessage: async (key) => {
      if (key?.id) {
        return messageStore.get(key.id);
      }
      return undefined;
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n================ SCAN QR CODE INI DI WHATSAPP ================');
      qrcode.generate(qr, { small: true });
      console.log('Buka WA di HP > Perangkat Tertaut > Tautkan Perangkat > Scan QR di atas\n');
    }

    if (connection === 'close') {
      currentSock = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Koneksi terputus (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log('Sesi logout. Hapus folder ./session dan scan QR ulang.');
      }
    } else if (connection === 'open') {
      currentSock = sock;
      console.log('========================================');
      console.log('✅ Bot WhatsApp Berhasil Terhubung & Aktif!');
      console.log('💡 [Console / Terminal Shell Aktif]');
      console.log('   Jika di terminal bash (~ $):');
      console.log('   👉 ./send <nomor> <pesan>       (Contoh: ./send 085281929641 halo)');
      console.log('   👉 node send.js <nomor> <pesan> (Contoh: node send.js 085281929641 halo)');
      console.log('   👉 send <nomor> <pesan>');
      console.log('   Jika di input console bot-hosting langsung:');
      console.log('   👉 send <nomor> <pesan>  |  help');
      console.log('========================================');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key?.id) {
        storeMessage(msg.key.id, msg.message);
      }
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const rawMsg = unwrapMessage(msg);
      if (!rawMsg) continue;

      const sender = msg.key.remoteJid;
      const userKey = msg.key.participant || sender;
      const isFromMe = Boolean(msg.key.fromMe);

      if (sender && sender.endsWith('@lid') && (isFromMe || userKey === sender)) {
        saveSelfLid(sender);
      }

      // Ambil teks dari berbagai kemungkinan pesan
      let bodyText = '';
      if (rawMsg.conversation) {
        bodyText = rawMsg.conversation;
      } else if (rawMsg.extendedTextMessage?.text) {
        bodyText = rawMsg.extendedTextMessage.text;
      } else if (rawMsg.imageMessage?.caption) {
        bodyText = rawMsg.imageMessage.caption;
      } else if (rawMsg.videoMessage?.caption) {
        bodyText = rawMsg.videoMessage.caption;
      }

      bodyText = (bodyText || '').trim();

      // Cek apakah ada game Tebak Kata yang sedang aktif di chat ini
      if (activeGames.has(sender)) {
        const game = activeGames.get(sender);
        const guess = bodyText.toLowerCase().trim();
        if (guess === game.answer) {
          clearTimeout(game.timer);
          activeGames.delete(sender);
          await sock.sendMessage(
            sender,
            { text: `🎉 *SELAMAT!* Jawaban kamu BENAR!\nJawaban: *${game.answer.toUpperCase()}* 🏆` },
            { quoted: msg }
          );
          continue;
        }
      }

      // Hanya proses pesan yang diawali prefix (contoh: .s, .menu)
      if (!bodyText.startsWith(config.prefix)) {
        continue;
      }

      await handleBotCommand(sock, {
        sender,
        bodyText,
        msg,
        rawMsg,
        isFromMe,
        userKey,
        isConsole: false
      });
    }
  });
}

setupConsoleCLI();
printPterodactylBanner();
startBot();
