const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
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
  const bot = metadata.participants.find((p) => p.id === sock.user.id);
  if (!['admin', 'superadmin'].includes(sender?.admin)) return { error: 'Hanya admin grup yang bisa menggunakan perintah ini.' };
  if (!['admin', 'superadmin'].includes(bot?.admin)) return { error: 'Jadikan bot admin grup terlebih dahulu untuk menjalankan tindakan ini.' };
  return { groupJid, metadata, senderJid, botJid: sock.user.id };
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
    browser: Browsers.macOS('Desktop'), // Menyamar sebagai browser desktop MacOS (anti-ban)
    syncFullHistory: false,
    markOnlineOnConnect: false // Jangan paksa online terus-menerus
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
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid;
      const messageContent = msg.message;
      const messageType = Object.keys(messageContent)[0];

      // Ambil teks dari berbagai jenis pesan
      let bodyText = '';
      if (messageType === 'conversation') {
        bodyText = messageContent.conversation;
      } else if (messageType === 'extendedTextMessage') {
        bodyText = messageContent.extendedTextMessage.text;
      } else if (messageType === 'imageMessage') {
        bodyText = messageContent.imageMessage.caption || '';
      }

      bodyText = (bodyText || '').trim();
      if (!bodyText.startsWith(config.prefix)) continue;

      const args = bodyText.slice(config.prefix.length).trim().split(/ +/);
      const command = args.shift().toLowerCase();

      // Cek proteksi anti-spam / anti-ban
      if (isCoolingDown(sender)) {
        console.log(`[Anti-Spam] Mengabaikan spam dari: ${sender}`);
        continue;
      }

      // Human-like typing delay simulasi
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
              `\n*ADMIN GRUP (khusus admin):*\n` +
              `• .kick/.promote/.demote @anggota\n• .mute/.unmute • .tagall • .groupinfo\n` +
              `• *${config.prefix}calc <angka>* : Kalkulator cepat (contoh: ${config.prefix}calc 50*12)\n\n` +
              `_Catatan: Bot dilengkapi fitur anti-spam & jeda alami._`;

            await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
            break;
          }

          case 's':
          case 'sticker': {
            // Cek apakah pesan sendiri adalah gambar atau me-reply gambar
            const isQuotedImage =
              messageType === 'extendedTextMessage' &&
              messageContent.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage;
            const isDirectImage = messageType === 'imageMessage';

            if (!isDirectImage && !isQuotedImage) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Kirim foto dengan caption *${config.prefix}s* atau reply foto dengan *${config.prefix}s*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang membuat stiker...' }, { quoted: msg });

            // Download media gambar
            let mediaMessageToDownload;
            if (isDirectImage) {
              mediaMessageToDownload = msg;
            } else {
              mediaMessageToDownload = {
                message: {
                  imageMessage: messageContent.extendedTextMessage.contextInfo.quotedMessage.imageMessage
                }
              };
            }

            const buffer = await downloadMediaMessage(
              mediaMessageToDownload,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }) }
            );

            const stickerWebp = await makeSticker(buffer);

            await sock.sendMessage(
              sender,
              { sticker: stickerWebp },
              { quoted: msg }
            );
            break;
          }

          case 'hd':
          case 'remini': {
            const isQuotedImage =
              messageType === 'extendedTextMessage' &&
              messageContent.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage;
            const isDirectImage = messageType === 'imageMessage';

            if (!isDirectImage && !isQuotedImage) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Kirim foto dengan caption *${config.prefix}hd* atau reply foto dengan *${config.prefix}hd*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang memperjelas & upscaling foto dengan AI...' }, { quoted: msg });

            let mediaMessageToDownload;
            if (isDirectImage) {
              mediaMessageToDownload = msg;
            } else {
              mediaMessageToDownload = {
                message: {
                  imageMessage: messageContent.extendedTextMessage.contextInfo.quotedMessage.imageMessage
                }
              };
            }

            const buffer = await downloadMediaMessage(
              mediaMessageToDownload,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }) }
            );

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
              // Evaluasi kalkulasi aritmatika aman
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
            // Perintah tidak dikenal diabaikan agar tidak spamming chat
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
