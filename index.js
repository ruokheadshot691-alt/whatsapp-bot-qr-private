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
const { makeSticker } = require('./src/sticker');
const { upscaleImage } = require('./src/hd');

// Tracking cooldown untuk fitur anti-blokir
const userCooldowns = new Map();
const userMsgCounts = new Map();

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
  if (!groupJid?.endsWith('@g.us')) return { error: 'Perintah ini hanya bisa dipakai di grup.' };
  const metadata = await sock.groupMetadata(groupJid);
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const sender = metadata.participants.find((p) => p.id === senderJid);
  const bot = metadata.participants.find((p) => p.id === sock.user?.id);
  if (!['admin', 'superadmin'].includes(sender?.admin)) return { error: 'Hanya admin grup yang bisa menggunakan perintah ini.' };
  if (!['admin', 'superadmin'].includes(bot?.admin)) return { error: 'Jadikan bot admin grup terlebih dahulu untuk menjalankan tindakan ini.' };
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
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Koneksi terputus (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log('Sesi logout. Hapus folder ./session dan scan QR ulang.');
      }
    } else if (connection === 'open') {
      console.log('========================================');
      console.log('✅ Bot WhatsApp Berhasil Terhubung & Aktif!');
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
      const command = args.shift().toLowerCase();

      console.log(`[Pesan Masuk] Command: ${config.prefix}${command} | Dari: ${sender} | Self: ${isFromMe}`);

      // Cek proteksi anti-spam (kecuali dari diri sendiri/owner)
      if (!isFromMe && isCoolingDown(sender)) {
        console.log(`[Anti-Spam] Mengabaikan spam dari: ${sender}`);
        continue;
      }

      // Jeda alami agar tidak seperti robot kaku
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
            const menuText = `🤖 *${config.botName} - Menu Utama*\n\n` +
              `*FITUR MEDIA & AI:*\n` +
              `• *${config.prefix}s* : Kirim/reply foto jadi stiker WA\n` +
              `• *${config.prefix}hd* : Perjelas & upscale kualitas foto\n\n` +
              `*FITUR UTILITAS:*\n` +
              `• *${config.prefix}ping* : Cek kecepatan respons bot\n` +
              `• *${config.prefix}owner* : Kontak pemilik bot\n` +
              `• *${config.prefix}runtime* : Cek waktu aktif bot\n` +
              `• *${config.prefix}calc <angka>* : Kalkulator (contoh: ${config.prefix}calc 50*12)\n\n` +
              `*ADMIN GRUP:*\n` +
              `• .kick/.promote/.demote @anggota\n• .mute/.unmute • .tagall • .groupinfo\n\n` +
              `_Catatan: Fitur stiker & HD mendukung kirim foto langsung atau reply foto._`;

            await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
            break;
          }

          case 's':
          case 'sticker': {
            // Cek foto langsung atau quoted foto
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

            await sock.sendMessage(
              sender,
              { sticker: stickerWebp },
              { quoted: msg }
            );
            console.log(`[Sticker Sukses] Stiker terkirim ke ${sender}`);
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
            console.log(`[HD Sukses] Foto HD terkirim ke ${sender}`);
            break;
          }

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

          case 'kick':
          case 'remove':
          case 'promote':
          case 'demote':
          case 'mute':
          case 'unmute':
          case 'tagall':
          case 'groupinfo': {
            const ctx = await getGroupAdminContext(sock, msg);
            if (ctx.error) {
              await sock.sendMessage(sender, { text: `⛔ ${ctx.error}` }, { quoted: msg });
              break;
            }

            if (command === 'groupinfo') {
              const admins = ctx.metadata.participants.filter((p) => ['admin', 'superadmin'].includes(p.admin));
              await sock.sendMessage(sender, { text: `📋 *${ctx.metadata.subject}*\nAnggota: ${ctx.metadata.participants.length}\nAdmin: ${admins.length}` }, { quoted: msg });
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

startBot();
