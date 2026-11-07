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

function normalizeConsoleJid(rawTarget) {
  if (!rawTarget) return null;
  let target = rawTarget.trim();

  // Keyword 'me' atau 'self' -> nomor bot sendiri
  if (target.toLowerCase() === 'me' || target.toLowerCase() === 'self') {
    if (currentSock?.user?.id) {
      const myNumber = currentSock.user.id.split(':')[0].split('@')[0];
      return myNumber + '@s.whatsapp.net';
    }
    return config.ownerNumber ? config.ownerNumber.replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null;
  }

  // Keyword 'owner' -> nomor owner di config
  if (target.toLowerCase() === 'owner') {
    return config.ownerNumber ? config.ownerNumber.replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null;
  }

  // Jika sudah memiliki suffix JID WhatsApp (@s.whatsapp.net, @g.us, @lid)
  if (target.includes('@')) {
    return target;
  }

  // Bersihkan karakter non-angka
  let cleanNumber = target.replace(/[^0-9]/g, '');
  if (!cleanNumber) return null;

  // Format 08xx -> 628xx
  if (cleanNumber.startsWith('08')) {
    cleanNumber = '62' + cleanNumber.slice(1);
  }

  return cleanNumber + '@s.whatsapp.net';
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

    const jid = normalizeConsoleJid(targetRaw);
    if (!jid) {
      console.log(`⚠️ [Console] Nomor tujuan "${targetRaw}" tidak valid.`);
      return;
    }

    try {
      console.log(`⏳ [Console] Mengirim pesan ke ${jid}...`);
      await currentSock.sendMessage(jid, { text: messageText });
      console.log(`✅ [Console Sukses] Pesan terkirim ke ${jid}: "${messageText}"`);
    } catch (err) {
      console.error(`❌ [Console Gagal] Tidak dapat mengirim pesan ke ${jid}:`, err.message);
    }
  });

  rl.on('error', (err) => {
    console.error('[Console CLI Error]:', err.message);
  });
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
    markOnlineOnConnect: false
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
      console.log('💡 [Console Panel Aktif] Ketik langsung di console bot-hosting:');
      console.log('   send <nomor/grup> <pesan>');
      console.log('   Contoh: send 081234567890 Halo dari console!');
      console.log('   Ketik "help" untuk daftar perintah console.');
      console.log('========================================');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const rawMsg = unwrapMessage(msg);
      if (!rawMsg) continue;

      const sender = msg.key.remoteJid;
      const userKey = msg.key.participant || sender;
      const isFromMe = Boolean(msg.key.fromMe);

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

      // Hanya proses pesan yang diawali prefix (contoh: .s, .menu)
      if (!bodyText.startsWith(config.prefix)) {
        continue;
      }

      const args = bodyText.slice(config.prefix.length).trim().split(/ +/);
      const command = (args.shift() || '').toLowerCase();
      // Perintah tanpa argumen dapat memakai isi pesan yang sedang di-reply.
      const quotedText = getQuotedText(rawMsg);
      if (args.length === 0 && quotedText) args.push(quotedText);

      console.log(`[Pesan Masuk] Command: ${config.prefix}${command} | Dari: ${sender} | Self: ${isFromMe}`);

      // Cek proteksi anti-spam (kecuali dari diri sendiri/owner)
      if (!isFromMe && isCoolingDown(sender)) {
        console.log(`[Anti-Spam] Mengabaikan spam dari: ${sender}`);
        continue;
      }

      // Jeda alami agar tidak seperti bot kaku
      const delay = Math.floor(
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
              `🎨 *MEDIA & AI*\n` +
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
  });
}

setupConsoleCLI();
startBot();
