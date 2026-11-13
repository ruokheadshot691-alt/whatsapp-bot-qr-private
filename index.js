const http = require('http');
const { useMongoDBAuthState } = require('./src/mongo-auth-state');
const readline = require('readline');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  Browsers,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { makeSticker, stickerToImage } = require('./src/sticker');
const { makeBratSticker, makeBratVideoSticker } = require('./src/brat');
const {
  normalizeNumber,
  getCurrentSessionInfo,
  backupCurrentSession,
  listSavedSessions,
  clearActiveSession,
  restoreSession,
  deleteSavedSession
} = require('./src/session-manager');
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
  searchImages,
  getRandomTebakKata,
  transcribeAudio,
  extractAudioFromVideo,
  fetchAndExtractText,
  getInstagramMedia
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

// Cache pesan untuk retry receipt dan metadata range clear per chat.
const messageStore = new Map();
const messageJidStore = new Map();
const recentMessagePerJid = new Map();
const chatHistoryPerJid = new Map();
const sentBotMessagesPerJid = new Map();
const SENT_MESSAGES_FILE = path.resolve(__dirname, 'data', 'sent-bot-messages.json');
const MESSAGE_STORE_FILE = path.resolve(__dirname, 'data', 'message-store.json');

try {
  if (fs.existsSync(MESSAGE_STORE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(MESSAGE_STORE_FILE, 'utf8'));
    for (const [id, msg] of Object.entries(saved)) {
      if (id && msg) messageStore.set(id, msg);
    }
  }
} catch (err) {
  console.warn('[MessageStore] Tidak dapat memuat cache pesan:', err?.message || err);
}

let saveMessageStoreTimer;
function persistMessageStore() {
  clearTimeout(saveMessageStoreTimer);
  saveMessageStoreTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(MESSAGE_STORE_FILE), { recursive: true });
      const entries = [...messageStore.entries()].slice(-1000);
      const saved = Object.fromEntries(entries);
      const temp = MESSAGE_STORE_FILE + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(saved), 'utf8');
      fs.renameSync(temp, MESSAGE_STORE_FILE);
    } catch (err) {
      console.warn('[MessageStore] Gagal menyimpan cache pesan:', err?.message || err);
    }
  }, 1000);
  saveMessageStoreTimer.unref?.();
}

try {
  if (fs.existsSync(SENT_MESSAGES_FILE)) {
    const saved = JSON.parse(fs.readFileSync(SENT_MESSAGES_FILE, 'utf8'));
    for (const [jid, list] of Object.entries(saved)) {
      if (Array.isArray(list)) sentBotMessagesPerJid.set(jid, list.slice(-200));
    }
  }
} catch (err) {
  console.warn('[ClearChat] Tidak dapat memuat cache pesan terkirim:', err?.message || err);
}

let saveSentMessagesTimer;
function persistSentMessages() {
  clearTimeout(saveSentMessagesTimer);
  saveSentMessagesTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(SENT_MESSAGES_FILE), { recursive: true });
      const saved = Object.fromEntries([...sentBotMessagesPerJid.entries()].map(([jid, list]) => [jid, list.slice(-200)]));
      const temp = SENT_MESSAGES_FILE + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(saved), 'utf8');
      fs.renameSync(temp, SENT_MESSAGES_FILE);
    } catch (err) {
      console.warn('[ClearChat] Tidak dapat menyimpan cache pesan terkirim:', err?.message || err);
    }
  }, 500);
  saveSentMessagesTimer.unref?.();
}

function normalizeChatJid(jid) {
  if (!jid) return '';
  const value = String(jid).trim().replace(/:[0-9]+@/, '@');
  try {
    const [user, server] = value.split('@');
    return server ? `${user}@${server}` : value;
  } catch { return value; }
}

function trackSentBotMessage(jid, key) {
  if (!jid || !key?.id) return;
  const clean = normalizeChatJid(jid);
  if (!sentBotMessagesPerJid.has(clean)) sentBotMessagesPerJid.set(clean, []);
  const list = sentBotMessagesPerJid.get(clean);
  const normalizedKey = {
    id: key.id,
    remoteJid: clean,
    fromMe: true,
    ...(key.participant ? { participant: normalizeChatJid(key.participant) } : {})
  };
  if (!list.some(item => item.id === key.id)) {
    list.push(normalizedKey);
    if (list.length > 200) list.shift();
    persistSentMessages();
  }
}

function trackChatMessage(msg) {
  if (!msg?.key?.id || !msg.key.remoteJid) return;
  const jid = normalizeChatJid(msg.key.remoteJid);
  const key = {
    id: msg.key.id,
    remoteJid: jid,
    fromMe: Boolean(msg.key.fromMe),
    ...(msg.key.participant ? { participant: normalizeChatJid(msg.key.participant) } : {})
  };
  const record = {
    key,
    messageTimestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)
  };
  const list = chatHistoryPerJid.get(jid) || [];
  if (!list.some(item => item.key.id === key.id)) {
    list.push(record);
    if (list.length > 100) list.shift();
    chatHistoryPerJid.set(jid, list);
  }
  recentMessagePerJid.set(jid, { ...msg, key, messageTimestamp: record.messageTimestamp });
}

function storeMessage(keyId, message, jid) {
  if (!keyId || !message) return;
  if (messageStore.size > 2000) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
    messageJidStore.delete(firstKey);
  }
  const cleanMsg = message.message ? message.message : message;
  messageStore.set(keyId, cleanMsg);
  if (jid) messageJidStore.set(keyId, normalizeChatJid(jid));
  persistMessageStore();
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

/**
 * Clear riwayat lokal chat WhatsApp dan hapus item chat dari daftar.
 * Baileys membutuhkan lastMessages berisi key dan timestamp yang valid.
 */
async function executeClearChat(sock, targetRaw, triggerMsg = null) {
  if (!sock) return { success: false, error: 'Socket bot belum diinisialisasi.' };
  if (!sock.user) return { success: false, error: 'Bot belum login atau belum terhubung ke WhatsApp.' };
  if (!targetRaw) return { success: false, error: 'Target nomor atau grup wajib diisi.' };

  let raw = String(targetRaw).trim();
  if (/^(me|self)$/i.test(raw)) raw = sock.user?.id || '';
  if (/^owner$/i.test(raw)) raw = config.ownerNumber || '';
  let jid;
  if (/@(?:g\.us|s\.whatsapp\.net|lid)$/.test(raw)) jid = raw;
  else {
    jid = normalizeConsoleJid(raw, sock);
    if (!jid) {
      const digits = raw.replace(/\D/g, '');
      if (!digits) return { success: false, error: `Format nomor target "${targetRaw}" tidak valid.` };
      jid = (digits.startsWith('08') ? '628' + digits.slice(2) : digits) + '@s.whatsapp.net';
    }
  }
  jid = normalizeChatJid(jid);

  const targets = new Set([jid]);
  const botJid = normalizeChatJid(sock.user?.id || '');
  const selfLid = normalizeChatJid(sock.user?.lid || knownSelfLid || '');
  const digits = jid.replace(/\D/g, '');
  if (jid === botJid || (!!digits && digits === botJid.replace(/\D/g, '')) || (!!selfLid && jid === selfLid)) {
    if (botJid) targets.add(botJid);
    if (selfLid) targets.add(selfLid);
  }

  const now = Math.floor(Date.now() / 1000);
  let clearSucceeded = false;
  let deleteChatSucceeded = false;
  let totalRevoked = 0;
  let lastErr = null;

  for (const target of targets) {
    for (const key of [...(sentBotMessagesPerJid.get(target) || [])]) {
      try {
        await sock.sendMessage(target, { delete: key });
        totalRevoked++;
      } catch (err) { lastErr = err?.message || String(err); }
    }
    sentBotMessagesPerJid.delete(target);

    const trigger = triggerMsg?.key?.id && normalizeChatJid(triggerMsg.key.remoteJid) === target
      ? {
          key: {
            id: triggerMsg.key.id,
            remoteJid: target,
            fromMe: Boolean(triggerMsg.key.fromMe),
            ...(triggerMsg.key.participant ? { participant: normalizeChatJid(triggerMsg.key.participant) } : {})
          },
          messageTimestamp: Number(triggerMsg.messageTimestamp) || now
        }
      : null;
    const recent = recentMessagePerJid.get(target);
    const history = chatHistoryPerJid.get(target) || [];
    const anchor = trigger || (recent?.key?.id ? {
      key: {
        id: recent.key.id,
        remoteJid: target,
        fromMe: Boolean(recent.key.fromMe),
        ...(recent.key.participant ? { participant: normalizeChatJid(recent.key.participant) } : {})
      },
      messageTimestamp: Number(recent.messageTimestamp) || now
    } : history[history.length - 1]);

    if (!anchor?.key?.id || !anchor?.key?.remoteJid || !Number(anchor.messageTimestamp)) {
      lastErr = `Tidak ada key pesan valid yang tersimpan untuk ${target}; kirim atau terima pesan di chat tersebut lalu coba lagi.`;
    } else {
      const lastMessages = [{ ...anchor, key: { ...anchor.key, remoteJid: target } }];
      try {
        await sock.chatModify({ clear: true, lastMessages }, target);
        clearSucceeded = true;
      } catch (err) {
        lastErr = err?.message || String(err);
        console.warn(`[ClearChat] clear gagal untuk ${target}:`, lastErr);
      }
      try {
        await sock.chatModify({ delete: true, lastMessages }, target);
        deleteChatSucceeded = true;
      } catch (err) {
        lastErr = err?.message || lastErr;
        console.warn(`[ClearChat] delete gagal untuk ${target}:`, err?.message || err);
      }
    }

    for (const [id, storedJid] of messageJidStore.entries()) {
      if (storedJid === target) {
        messageStore.delete(id);
        messageJidStore.delete(id);
      }
    }
    chatHistoryPerJid.delete(target);
    recentMessagePerJid.delete(target);
  }

  persistSentMessages();
  const success = clearSucceeded || totalRevoked > 0;
  const displayNum = jid.split('@')[0];
  if (success) console.log(`[ClearChat] Aksi clear diterima: ${clearSucceeded}; chat dihapus dari daftar: ${deleteChatSucceeded}; pesan bot ditarik: ${totalRevoked}.`);
  else console.warn(`[ClearChat] Gagal untuk ${jid}: ${lastErr || 'WhatsApp tidak mengonfirmasi perubahan.'}`);
  return { success, targetJid: jid, displayNum, totalRevoked, error: success ? null : (lastErr || 'WhatsApp tidak mengonfirmasi perubahan.') };
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


/**
 * Mengirim hasil pencarian Pinterest dalam format Carousel interaktif yang bisa digeser (swipeable cards).
 * Jika kartu < 2 atau pengiriman native flow ditolak, otomatis fallback ke pengiriman multi-gambar.
 */
async function sendPinterestCarousel(sock, sender, query, msg) {
  const items = await searchImages(query, 6);
  if (!items || items.length === 0) {
    throw new Error(`Gambar untuk "${query}" tidak ditemukan.`);
  }

  const cards = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const imgRes = await axios.get(item.url, {
        responseType: 'arraybuffer',
        timeout: 9000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.pinterest.com/'
        }
      });

      const media = await prepareWAMessageMedia(
        { image: Buffer.from(imgRes.data) },
        { upload: sock.waUploadToServer }
      );

      if (!media || !media.imageMessage) continue;

      const cardTitle = item.title ? (item.title.length > 40 ? item.title.slice(0, 37) + '...' : item.title) : `Pin #${cards.length + 1}`;
      const cardBody = item.description ? (item.description.length > 90 ? item.description.slice(0, 87) + '...' : item.description) : `Hasil estetika untuk "${query}"`;

      cards.push({
        header: {
          title: `📌 ${cardTitle}`,
          hasMediaAttachment: true,
          imageMessage: media.imageMessage
        },
        body: {
          text: cardBody
        },
        footer: {
          text: `Pinterest • Gambar ${cards.length + 1} dari ${items.length}`
        },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: '🌐 Buka Sumber',
                url: item.link || item.url,
                merchant_url: item.link || item.url
              })
            },
            {
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: '🔍 Cari Lagi',
                id: `${config.prefix}pin ${query}`
              })
            }
          ]
        }
      });
    } catch (cardErr) {
      console.warn(`[Pin Carousel Card #${i + 1} Skip]:`, cardErr.message);
    }
  }

  // Jika kartu terkumpul >= 2, kirim carousel native yang bisa digeser
  if (cards.length >= 2) {
    try {
      const INTERACTIVE_NATIVE_FLOW_NODES = [
        {
          tag: 'biz',
          attrs: {},
          content: [
            {
              tag: 'interactive',
              attrs: { type: 'native_flow', v: '1' },
              content: [{ tag: 'native_flow', attrs: { name: 'mixed', v: '9' } }]
            }
          ]
        }
      ];

      const userJid = sock.user?.id || sender;
      const inner = {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              body: {
                text: `🖼️ *Hasil Pencarian Pinterest:* "${query}"\n👉 *Geser ke samping (swipe)* untuk melihat ${cards.length} kartu gambar pilihan!`
              },
              carouselMessage: {
                cards: cards,
                messageVersion: 1
              }
            }
          }
        }
      };

      const waMsg = generateWAMessageFromContent(sender, inner, { userJid, quoted: msg });
      if (waMsg.key?.id && waMsg.message) {
        storeMessage(waMsg.key.id, waMsg.message, sender);
        trackSentBotMessage(sender, waMsg.key);
      }
      await sock.relayMessage(sender, waMsg.message, {
        messageId: waMsg.key.id,
        additionalNodes: INTERACTIVE_NATIVE_FLOW_NODES
      });
      return;
    } catch (relayErr) {
      console.warn('[Pin Carousel Relay Error, falling back to multi-send]:', relayErr.message);
    }
  }

  // Fallback jika carousel gagal atau kartu < 2: kirim beberapa gambar teratas langsung
  const fallbackList = items.slice(0, 3);
  for (let i = 0; i < fallbackList.length; i++) {
    const item = fallbackList[i];
    await sock.sendMessage(
      sender,
      {
        image: { url: item.url },
        caption: `🖼️ *[${i + 1}/${fallbackList.length}]* ${item.title || query}\n🔗 ${item.link || item.url}`
      },
      i === 0 ? { quoted: msg } : {}
    );
  }
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
              `• *${config.prefix}ig <link>* : Unduh Reels / Video / Postingan Instagram\n` +
              `• *${config.prefix}dl <link>* : Unduh video TikTok / Instagram / media link otomatis\n` +
              `• *${config.prefix}tt <link>* : Download video TikTok tanpa watermark\n` +
              `• *${config.prefix}pin <kata>* : Cari gambar Pinterest (Carousel bisa digeser)\n` +
              `• *${config.prefix}ssweb <link>* : Screenshot tampilan website\n\n` +
              `🎙️ *AUDIO & SUARA*\n` +
              `• *${config.prefix}transkrip* : Reply VN/audio untuk diubah jadi teks otomatis\n` +
              `• *${config.prefix}tomp3* : Reply video untuk diekstrak jadi file audio MP3\n` +
              `• *${config.prefix}tovn* : Reply video untuk diubah jadi Voice Note (VN)\n` +
              `• *${config.prefix}tts <teks>* : Suara Google Voice Note (Indonesia)\n` +
              `• *${config.prefix}bass* : Reply audio untuk efek bass boost\n` +
              `• *${config.prefix}slow* : Reply audio untuk efek slow + reverb\n` +
              `• *${config.prefix}chipmunk* : Reply audio untuk suara cempreng tupai\n\n` +
              `🤖 *ARTIFICIAL INTELLIGENCE*\n` +
              `• *${config.prefix}ringkas <link/teks>* : Ringkas artikel berita atau pesan panjang\n` +
              `• *${config.prefix}ai <tanya>* : Tanya AI (Mendukung memori percakapan)\n` +
              `• *${config.prefix}resetai* : Hapus ingatan percakapan AI\n` +
              `• *${config.prefix}persona <karakter>* : Atur persona AI pribadi\n` +
              `• *${config.prefix}persona reset* : Hapus persona khusus\n\n` +
              `🛠️ *TOOLS & UTILITAS*\n` +
              `• *${config.prefix}gempa* : Info gempa bumi BMKG terkini + peta\n` +
              `• *${config.prefix}menfess <nomor> <pesan>* : Kirim pesan rahasia anonim\n` +
              `• *${config.prefix}qr <teks/link>* : Buat gambar QR Code\n` +
              `• *${config.prefix}tr <kode> <teks>* : Terjemahan bahasa (.tr en halo)\n` +
              `• *${config.prefix}wiki <kata>* : Cari ringkasan di Wikipedia\n` +
              `• *${config.prefix}short <link>* : Buat shortlink TinyURL\n` +
              `• *${config.prefix}cuaca <kota>* : Cek cuaca & suhu kota realtime\n` +
              `• *${config.prefix}calc <angka>* : Kalkulator (${config.prefix}calc 25*40)\n• *${config.prefix}clearchat <nomor>* : Hapus semua riwayat chat nomor target\n\n` +
              `⚙️ *MANAJEMEN SESI & AKUN (Owner)*\n` +
              `• *${config.prefix}listsesi* : Lihat nomor WA yang pernah ditautkan\n` +
              `• *${config.prefix}tautkan <nomor>* : Hubungkan kembali ke nomor tersimpan (tanpa QR)\n` +
              `• *${config.prefix}unlink* : Putus tautan nomor saat ini & scan QR baru\n` +
              `• *${config.prefix}hapussesi <nomor>* : Hapus data sesi lama dari server\n\n` +
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
            let targetText = args.join(' ').trim();
            const quotedBrat = rawMsg.extendedTextMessage?.contextInfo;
            if (!targetText && quotedBrat?.quotedMessage) {
              const unquoted = unwrapMessage({ message: quotedBrat.quotedMessage });
              const qText = unquoted?.conversation || unquoted?.extendedTextMessage?.text || '';
              if (qText) targetText = qText.trim();
            }
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
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker Brat. Coba gunakan kalimat yang berbeda.' }, { quoted: msg });
            }
            break;
          }

          case 'bratvid':
          case 'bratvideo':
          case 'bratgif':
          case 'bratv': {
            let targetText = args.join(' ').trim();
            const quotedBratVid = rawMsg.extendedTextMessage?.contextInfo;
            if (!targetText && quotedBratVid?.quotedMessage) {
              const unquoted = unwrapMessage({ message: quotedBratVid.quotedMessage });
              const qText = unquoted?.conversation || unquoted?.extendedTextMessage?.text || '';
              if (qText) targetText = qText.trim();
            }
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
              await sock.sendMessage(sender, { text: '❌ Gagal membuat stiker video Brat. Coba gunakan kalimat yang lebih singkat.' }, { quoted: msg });
            }
            break;
          }

          // ------------------ FITUR BARU: QUOTE CHAT & MEME STICKER ------------------
          case 'qc': {
            let targetText = args.join(' ').trim();
            let authorName = msg.pushName || userKey.split('@')[0] || 'Seseorang';
            let targetJid = sender.endsWith('@g.us') ? (msg.key.participant || userKey) : userKey;

            const quoted = rawMsg.extendedTextMessage?.contextInfo;
            if (quoted?.quotedMessage) {
              const unquoted = unwrapMessage({ message: quoted.quotedMessage });
              const qText = unquoted?.conversation || unquoted?.extendedTextMessage?.text || '';
              if (qText) targetText = qText.trim();
              if (quoted.participant) {
                targetJid = quoted.participant;
                authorName = quoted.participant.split('@')[0];
                try {
                  if (sender.endsWith('@g.us')) {
                    const groupMeta = await sock.groupMetadata(sender);
                    const quotedParticipant = groupMeta?.participants?.find(p => p.id === quoted.participant);
                    if (quotedParticipant?.notify) authorName = quotedParticipant.notify;
                  }
                } catch {}
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
              let avatarBuffer = null;
              try {
                if (sock.profilePictureUrl && targetJid) {
                  const avatarUrl = await sock.profilePictureUrl(targetJid, 'image');
                  if (avatarUrl) {
                    const avatarRes = await axios.get(avatarUrl, {
                      responseType: 'arraybuffer',
                      timeout: 5000,
                      maxContentLength: 2 * 1024 * 1024
                    });
                    avatarBuffer = Buffer.from(avatarRes.data);
                  }
                }
              } catch (pfpErr) {
                // Private/no profile picture is normal, fallback to initials badge
              }

              const qcWebp = await makeQcSticker(targetText, authorName, avatarBuffer);
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
            let targetType = 'audio';

            // 1. Cek langsung di pesan
            if (rawMsg.audioMessage) {
              targetAudio = rawMsg.audioMessage;
              targetType = 'audio';
            } else if (rawMsg.videoMessage) {
              targetAudio = rawMsg.videoMessage;
              targetType = 'video';
            }

            // 2. Cek quoted message jika tidak ada audio langsung
            if (!targetAudio) {
              const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
              const stanzaId = rawMsg.extendedTextMessage?.contextInfo?.stanzaId;
              let unquoted = quoted ? unwrapMessage({ message: quoted }) : null;

              // Fallback jika quotedMessage hanya membawa stub tanpa mediaKey lengkap
              if (stanzaId && messageStore.has(stanzaId)) {
                const stored = messageStore.get(stanzaId);
                const unwrappedStored = unwrapMessage({ message: stored }) || stored;
                if (unwrappedStored?.audioMessage || unwrappedStored?.videoMessage || unwrappedStored?.documentMessage) {
                  unquoted = unwrappedStored;
                }
              }

              if (unquoted?.audioMessage) {
                targetAudio = unquoted.audioMessage;
                targetType = 'audio';
              } else if (unquoted?.videoMessage) {
                targetAudio = unquoted.videoMessage;
                targetType = 'video';
              } else if (unquoted?.documentMessage) {
                const mime = (unquoted.documentMessage.mimetype || '').toLowerCase();
                const fn = (unquoted.documentMessage.fileName || '').toLowerCase();
                if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(fn)) {
                  targetAudio = unquoted.documentMessage;
                  targetType = 'document';
                }
              }
            }

            if (!targetAudio) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Reply (balas) pesan audio, voice note, atau video dengan perintah *${config.prefix}${command}*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: `⏳ Sedang menerapkan efek audio *${command}*...` }, { quoted: msg });

            try {
              const audioBuffer = await getMediaBuffer(targetAudio, targetType);
              const modifiedOgg = applyAudioEffect(audioBuffer, command);
              await sock.sendMessage(
                sender,
                { audio: modifiedOgg, mimetype: 'audio/ogg; codecs=opus', ptt: true },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[AudioFX Error]:', err.message);
              try {
                // Fallback kirim non-PTT jika WhatsApp player menolak PTT
                const audioBuffer = await getMediaBuffer(targetAudio, targetType);
                const modifiedOgg = applyAudioEffect(audioBuffer, command);
                await sock.sendMessage(
                  sender,
                  { audio: modifiedOgg, mimetype: 'audio/mp4', ptt: false },
                  { quoted: msg }
                );
              } catch (err2) {
                await sock.sendMessage(sender, { text: '❌ Gagal memproses efek audio: ' + err.message }, { quoted: msg });
              }
            }
            break;
          }

                    // ------------------ FITUR BARU: TRANSKRIP SUARA & KONVERSI AUDIO ------------------
          case 'transkrip':
          case 'toteks': {
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
                { text: `⚠️ Reply pesan suara (Voice Note) atau audio dengan perintah *${config.prefix}${command}*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '🎙️ Sedang mendengarkan dan mentranskripsi audio ke teks...' }, { quoted: msg });

            try {
              const audioBuffer = await getMediaBuffer(targetAudio, 'audio');
              const textResult = await transcribeAudio(audioBuffer, 'id-ID');
              await sock.sendMessage(
                sender,
                { text: `📝 *HASIL TRANSKRIP SUARA*

"${textResult}"` },
                { quoted: msg }
              );
            } catch (err) {
              console.error('[Transkrip Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal transkripsi suara: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'tomp3':
          case 'tovn': {
            let targetVideo = null;
            if (rawMsg.videoMessage) {
              targetVideo = rawMsg.videoMessage;
            } else {
              const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
              if (quoted) {
                const unquoted = unwrapMessage({ message: quoted });
                if (unquoted?.videoMessage) {
                  targetVideo = unquoted.videoMessage;
                }
              }
            }

            if (!targetVideo) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Reply pesan video dengan perintah *${config.prefix}${command}* untuk mengekstrak audionya!` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '🎵 Sedang mengekstrak audio dari video...' }, { quoted: msg });

            try {
              const videoBuffer = await getMediaBuffer(targetVideo, 'video');
              const isVn = command === 'tovn';
              const audioBuffer = extractAudioFromVideo(videoBuffer, isVn);

              if (isVn) {
                await sock.sendMessage(
                  sender,
                  { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true },
                  { quoted: msg }
                );
              } else {
                await sock.sendMessage(
                  sender,
                  { audio: audioBuffer, mimetype: 'audio/mpeg' },
                  { quoted: msg }
                );
              }
            } catch (err) {
              console.error('[Audio Extract Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal mengekstrak audio: ' + err.message }, { quoted: msg });
            }
            break;
          }

          // ------------------ FITUR DOWNLOADER INSTAGRAM ------------------
          case 'ig':
          case 'igdl':
          case 'instagram': {
            let url = (args[0] || '').trim();
            if (!url) {
              const textToCheck = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                rawMsg.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || '';
              const igMatch = textToCheck.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv|share)\/[a-zA-Z0-9_-]+/i);
              if (igMatch) url = igMatch[0];
            }

            if (!url || !url.includes('instagram.com')) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan link Reel / Video Instagram!\nContoh: *${config.prefix}ig https://www.instagram.com/reel/DeJfc72SR0V/*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '⏳ Sedang mengunduh media Instagram, mohon tunggu sebentar...' }, { quoted: msg });

            try {
              const mediaList = await getInstagramMedia(url);
              const videos = mediaList.filter(m => m.type === 'video');
              const photos = mediaList.filter(m => m.type === 'photo');

              if (videos.length > 0) {
                for (let i = 0; i < Math.min(videos.length, 3); i++) {
                  const item = videos[i];
                  try {
                    await sock.sendMessage(
                      sender,
                      {
                        video: { url: item.url },
                        caption: `📸 *INSTAGRAM DOWNLOADER*\n\n🔗 ${url}`
                      },
                      { quoted: msg }
                    );
                  } catch (eSend) {
                    const r = await fetch(item.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    const buf = Buffer.from(await r.arrayBuffer());
                    await sock.sendMessage(
                      sender,
                      {
                        video: buf,
                        caption: `📸 *INSTAGRAM DOWNLOADER*\n\n🔗 ${url}`
                      },
                      { quoted: msg }
                    );
                  }
                }
              } else if (photos.length > 0) {
                for (let i = 0; i < Math.min(photos.length, 3); i++) {
                  const item = photos[i];
                  await sock.sendMessage(
                    sender,
                    {
                      image: { url: item.url },
                      caption: `📸 *INSTAGRAM DOWNLOADER*\n\n🔗 ${url}`
                    },
                    { quoted: msg }
                  );
                }
              } else {
                throw new Error('Media tidak ditemukan atau postingan bersifat privat.');
              }
            } catch (err) {
              console.error('[IG Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal mengunduh Instagram: ' + err.message }, { quoted: msg });
            }
            break;
          }

          case 'dl': {
            const url = args[0] || '';
            if (!url || !url.startsWith('http')) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Masukkan link video atau media!
Contoh:
• *${config.prefix}dl https://www.instagram.com/reel/xxxxxx/*
• *${config.prefix}dl https://vt.tiktok.com/xxxxxx/*` },
                { quoted: msg }
              );
              break;
            }

            if (url.includes('instagram.com')) {
              await sock.sendMessage(sender, { text: '⏳ Sedang mengunduh media Instagram...' }, { quoted: msg });
              try {
                const mediaList = await getInstagramMedia(url);
                const item = mediaList.find(m => m.type === 'video') || mediaList[0];
                if (!item) throw new Error('Tidak ada media yang dapat diunduh.');

                if (item.type === 'video') {
                  try {
                    await sock.sendMessage(sender, { video: { url: item.url }, caption: `📸 *INSTAGRAM DOWNLOADER*\n\n🔗 ${url}` }, { quoted: msg });
                  } catch {
                    const r = await fetch(item.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    const buf = Buffer.from(await r.arrayBuffer());
                    await sock.sendMessage(sender, { video: buf, caption: `📸 *INSTAGRAM DOWNLOADER*\n\n🔗 ${url}` }, { quoted: msg });
                  }
                } else {
                  await sock.sendMessage(sender, { image: { url: item.url }, caption: `📸 *INSTAGRAM DOWNLOADER*\n\n🔗 ${url}` }, { quoted: msg });
                }
              } catch (err) {
                console.error('[IG Error]:', err.message);
                await sock.sendMessage(sender, { text: '❌ Gagal unduh Instagram: ' + err.message }, { quoted: msg });
              }
              break;
            }

            if (url.includes('tiktok.com') || url.includes('douyin.com')) {
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

            if (/\.(mp4|mov|webm)(\?.*)?$/i.test(url)) {
              await sock.sendMessage(sender, { text: '⏳ Sedang mengunduh file video...' }, { quoted: msg });
              try {
                await sock.sendMessage(
                  sender,
                  { video: { url: url }, caption: '🎬 *BERHASIL DIUNDUH*' },
                  { quoted: msg }
                );
              } catch (err) {
                await sock.sendMessage(sender, { text: '❌ Gagal mengirim video: ' + err.message }, { quoted: msg });
              }
              break;
            }

            await sock.sendMessage(
              sender,
              { text: `ℹ️ Downloader saat ini mendukung video TikTok tanpa watermark dan link direct video (mp4). Untuk TikTok juga bisa langsung gunakan *${config.prefix}tt <link>*.` },
              { quoted: msg }
            );
            break;
          }

          // ------------------ FITUR BARU: RINGKAS DOKUMEN & BERITA ------------------
          case 'ringkas':
          case 'summarize': {
            let inputUrl = '';
            let inputText = '';

            const rawText = args.join(' ').trim();
            const quotedText = getQuotedText(rawMsg);

            if (rawText.startsWith('http://') || rawText.startsWith('https://')) {
              inputUrl = rawText.split(/\s+/)[0];
            } else if (quotedText.startsWith('http://') || quotedText.startsWith('https://')) {
              inputUrl = quotedText.split(/\s+/)[0];
            } else if (rawText) {
              inputText = rawText;
            } else if (quotedText) {
              inputText = quotedText;
            }

            if (!inputUrl && !inputText) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Kirim link artikel atau reply pesan teks panjang yang ingin diringkas!\n\n*Contoh:* \n• *${config.prefix}ringkas https://kompas.com/artikel...*\n• Reply pesan panjang dengan ketik *${config.prefix}ringkas*` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(sender, { text: '🧠 Sedang membaca dan merangkum intisari...' }, { quoted: msg });

            try {
              let title = '';
              let contentToSummarize = '';

              if (inputUrl) {
                const extracted = await fetchAndExtractText(inputUrl);
                title = extracted.title;
                contentToSummarize = extracted.text;
              } else {
                contentToSummarize = inputText.slice(0, 4500);
              }

              const prompt = `Tolong buat ringkasan yang jelas, rapi, dan mudah dipahami dalam Bahasa Indonesia dari materi berikut. Format output dalam 3-5 poin penting (bullet points) yang merangkum inti masalah dan kesimpulan:\n\n${contentToSummarize}`;
              const summary = await askAI(prompt, [], userKey, 'default');

              let replyMsg = `📋 *RINGKASAN INTISARI*\n`;
              if (title) replyMsg += `📌 *Judul:* ${title}\n`;
              replyMsg += `\n${summary}`;

              await sock.sendMessage(sender, { text: replyMsg }, { quoted: msg });
            } catch (err) {
              console.error('[Ringkas Error]:', err.message);
              await sock.sendMessage(sender, { text: '❌ Gagal membuat ringkasan: ' + err.message }, { quoted: msg });
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

            await sock.sendMessage(sender, { text: `🔍 Sedang mencari gambar Pinterest "${query}"...` }, { quoted: msg });

            try {
              await sendPinterestCarousel(sock, sender, query, msg);
            } catch (err) {
              console.error('[Pinterest Search Error]:', err.message);
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

          // ------------------ MANAJEMEN SESI & PERGANTIAN NOMOR ------------------
          case 'unlink':
          case 'putus':
          case 'disconnect': {
            const cleanSender = (userKey || sender).replace(/[^0-9]/g, '');
            const cleanOwner = (config.ownerNumber || '').replace(/[^0-9]/g, '');
            const isOwner = isFromMe || isConsole || (cleanOwner && cleanSender.startsWith(cleanOwner));

            if (!isOwner) {
              await sock.sendMessage(sender, { text: '❌ Hanya owner bot yang dapat memutus tautan sesi nomor.' }, { quoted: msg });
              break;
            }

            const curInfo = getCurrentSessionInfo();
            const curNum = curInfo.number ? `+${curInfo.number}` : 'nomor saat ini';

            await sock.sendMessage(
              sender,
              { text: `⏳ *Memutus tautan bot (${curNum})...*\n\nData sesi nomor ini telah disimpan dengan aman di server. Bot akan memulai ulang dan memunculkan *QR Code baru* di console/terminal untuk nomor baru.\n\n💡 Kamu bisa menautkan kembali nomor ini kapan saja dengan perintah: *${config.prefix}tautkan ${curInfo.number || '<nomor>'}*` },
              { quoted: msg }
            );

            await sleep(1500);

            if (curInfo.exists && curInfo.number) {
              backupCurrentSession();
            }
            clearActiveSession();
            console.log(`🔄 [Session Manager] Tautan nomor ${curNum} diputus oleh owner. Memulai QR code baru...`);
            await restartBotSession(2000);
            break;
          }

          case 'listsesi':
          case 'sesi':
          case 'daftarsesi':
          case 'sessions': {
            const cleanSender = (userKey || sender).replace(/[^0-9]/g, '');
            const cleanOwner = (config.ownerNumber || '').replace(/[^0-9]/g, '');
            const isOwner = isFromMe || isConsole || (cleanOwner && cleanSender.startsWith(cleanOwner));

            if (!isOwner) {
              await sock.sendMessage(sender, { text: '❌ Hanya owner bot yang dapat melihat daftar sesi tersimpan.' }, { quoted: msg });
              break;
            }

            const sessions = listSavedSessions();
            if (!sessions.length) {
              await sock.sendMessage(
                sender,
                { text: '📋 *Belum ada sesi nomor lain yang tersimpan di server.*\nSesi nomor saat ini akan otomatis tersimpan saat bot aktif.' },
                { quoted: msg }
              );
              break;
            }

            let text = '📱 *DAFTAR NOMOR WHATSAPP TERSIMPAN*\n\n';
            sessions.forEach((s, idx) => {
              const status = s.isActive ? '🟢 *[SEDANG AKTIF]*' : '⚪ _[Tersimpan]_';
              text += `${idx + 1}. *+${s.number}* (${s.name})\n   Status: ${status}\n\n`;
            });

            text += `💡 *Perintah Tersedia:*\n` +
                    `• *${config.prefix}tautkan <nomor>* : Hubungkan kembali ke nomor tersimpan (tanpa scan QR)\n` +
                    `• *${config.prefix}unlink* : Putus tautan nomor saat ini & scan QR baru\n` +
                    `• *${config.prefix}hapussesi <nomor>* : Hapus sesi nomor lama dari server`;

            await sock.sendMessage(sender, { text }, { quoted: msg });
            break;
          }

          case 'tautkan':
          case 'relink':
          case 'switch':
          case 'pakaisesi': {
            const cleanSender = (userKey || sender).replace(/[^0-9]/g, '');
            const cleanOwner = (config.ownerNumber || '').replace(/[^0-9]/g, '');
            const isOwner = isFromMe || isConsole || (cleanOwner && cleanSender.startsWith(cleanOwner));

            if (!isOwner) {
              await sock.sendMessage(sender, { text: '❌ Hanya owner bot yang dapat beralih nomor sesi.' }, { quoted: msg });
              break;
            }

            const targetInput = (args[0] || '').trim();
            if (!targetInput) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ *Format salah!*\nGunakan: *${config.prefix}tautkan <nomor>*\nContoh: *${config.prefix}tautkan 085284907957*\n\nKetik *${config.prefix}listsesi* untuk melihat daftar nomor tersimpan.` },
                { quoted: msg }
              );
              break;
            }

            const curInfo = getCurrentSessionInfo();
            const normalizedTarget = normalizeNumber(targetInput);
            if (curInfo.exists && curInfo.number === normalizedTarget) {
              await sock.sendMessage(
                sender,
                { text: `ℹ️ Nomor *+${curInfo.number}* sudah merupakan nomor aktif yang sedang terhubung.` },
                { quoted: msg }
              );
              break;
            }

            if (curInfo.exists && curInfo.number) {
              backupCurrentSession();
            }

            const restoreRes = restoreSession(targetInput);
            if (!restoreRes.success) {
              await sock.sendMessage(
                sender,
                { text: `❌ *Gagal menautkan:* ${restoreRes.error}` },
                { quoted: msg }
              );
              break;
            }

            await sock.sendMessage(
              sender,
              { text: `🔄 *Mengalihkan bot ke nomor +${restoreRes.number} (${restoreRes.name})...*\n\nBot sedang menghubungkan kembali ke nomor tersebut tanpa perlu scan QR ulang. Tunggu 3-5 detik.` },
              { quoted: msg }
            );

            await sleep(1500);
            await restartBotSession(2000);
            break;
          }

          case 'hapussesi':
          case 'delsesi': {
            const cleanSender = (userKey || sender).replace(/[^0-9]/g, '');
            const cleanOwner = (config.ownerNumber || '').replace(/[^0-9]/g, '');
            const isOwner = isFromMe || isConsole || (cleanOwner && cleanSender.startsWith(cleanOwner));

            if (!isOwner) {
              await sock.sendMessage(sender, { text: '❌ Hanya owner bot yang dapat menghapus file sesi.' }, { quoted: msg });
              break;
            }

            const targetInput = (args[0] || '').trim();
            if (!targetInput) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ *Format salah!*\nGunakan: *${config.prefix}hapussesi <nomor>*\nContoh: *${config.prefix}hapussesi 081234567890*` },
                { quoted: msg }
              );
              break;
            }

            const curInfo = getCurrentSessionInfo();
            const normalizedTarget = normalizeNumber(targetInput);
            if (curInfo.exists && curInfo.number === normalizedTarget) {
              await sock.sendMessage(
                sender,
                { text: `⚠️ Nomor *+${curInfo.number}* sedang aktif digunakan bot! Gunakan *${config.prefix}unlink* jika ingin melepaskannya.` },
                { quoted: msg }
              );
              break;
            }

            const delRes = deleteSavedSession(targetInput);
            if (delRes.success) {
              await sock.sendMessage(
                sender,
                { text: `🗑️ *Sukses:* Sesi nomor *+${delRes.number}* berhasil dihapus dari daftar server.` },
                { quoted: msg }
              );
            } else {
              await sock.sendMessage(
                sender,
                { text: `❌ *Gagal:* ${delRes.error}` },
                { quoted: msg }
              );
            }
            break;
          }

          // ------------------ FITUR HAPUS SEMUA CHAT ------------------
          case 'clearchat':
          case 'delchat':
          case 'hapuschat': {
            // Beri reaksi '🧹' segera agar user tahu perintah sedang berjalan
            const cleanSender = (userKey || sender).replace(/[^0-9]/g, '');
            const cleanOwner = (config.ownerNumber || '').replace(/[^0-9]/g, '');
            const botNum = sock?.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : '';
            let selfLid = sock?.user?.lid || '';
            try {
              if (!selfLid && typeof knownSelfLid !== 'undefined' && knownSelfLid) {
                selfLid = knownSelfLid;
              }
            } catch {}
            let savedNumbers = [];
            try {
              savedNumbers = listSavedSessions().map(s => s.number.replace(/[^0-9]/g, ''));
            } catch {}

            let targetRaw = (args[0] || '').trim();
            // Jika tidak ada argumen target nomor: targetnya adalah obrolan saat ini!
            if (!targetRaw) {
              targetRaw = sender;
            }

            // Cek apakah target adalah chat saat ini (lawan bicara / diri sendiri)
            const isTargetCurrentChat = (targetRaw === sender) || 
              (userKey && targetRaw === userKey) ||
              (cleanSender && targetRaw.replace(/[^0-9]/g, '') === cleanSender);

            const isOwner = isFromMe || isConsole ||
              (botNum && (cleanSender === botNum || cleanSender.startsWith(botNum))) ||
              (selfLid && (sender === selfLid || userKey === selfLid || sender.includes(selfLid.replace(/[^0-9]/g, '')))) ||
              (cleanOwner && cleanSender.startsWith(cleanOwner)) ||
              (cleanOwner === '6281234567890' || !cleanOwner) || // Jika belum diset, auto-izinkan pengirim
              savedNumbers.some(num => num && (cleanSender.startsWith(num) || num.startsWith(cleanSender)));

            // Jika bukan owner dan BUKAN membersihkan chatnya sendiri: tolak
            if (!isOwner && !isTargetCurrentChat) {
              console.warn(`[ClearChat Ditolak] ${cleanSender} bukan owner.`);
              if (msg?.key) {
                try {
                  await sock.sendMessage(sender, { react: { text: '⛔', key: msg.key } });
                  await sock.sendMessage(sender, { text: '⛔ Perintah hapus chat nomor lain hanya dapat digunakan oleh Owner.' }, { quoted: msg });
                } catch {}
              }
              break;
            }

            // Jika cleanOwner masih default, jadikan nomor pengirim ini sebagai owner aktif
            if ((!cleanOwner || cleanOwner === '6281234567890') && cleanSender && cleanSender.length >= 10 && cleanSender !== botNum) {
              config.ownerNumber = cleanSender;
              console.log(`[Config Update] Owner otomatis diset ke nomor pengirim: ${cleanSender}`);
            }

            // Eksekusi clearchat dengan pesan pemicu untuk referensi key
            const result = await executeClearChat(sock, targetRaw, msg);

            if (result.success) {
              // Jangan kirim reaksi atau balasan ke chat yang baru saja dibersihkan.
              if (msg?.key && !isTargetCurrentChat) {
                try {
                  await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                  if (!isFromMe) {
                    await sock.sendMessage(sender, { text: `✅ Aksi clear chat dikirim ke WhatsApp untuk *${result.displayNum}*. Pesan bot yang ditarik: ${result.totalRevoked || 0}.` }, { quoted: msg });
                  }
                } catch {}
              }
            } else {
              console.warn(`[ClearChat Gagal] ${result.error}`);
              if (msg?.key) {
                try {
                  await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } });
                  await sock.sendMessage(sender, { 
                    text: `❌ Gagal membersihkan chat (${result.displayNum || targetRaw}):
_${result.error}_

_Catatan: Bot harus dalam kondisi aktif terhubung ke WhatsApp._` 
                  }, { quoted: msg });
                } catch {}
              }
            }
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
  "transkrip", "toteks", "tomp3", "tovn", "dl", "ig", "igdl", "instagram", "ringkas", "summarize", "tt", "tiktok", "pin", "img", "pinterest", "ssweb", "screenshot", "gempa",
  "menfess", "confess", "tebakkata", "s", "sticker", "toimg", "hd", "remini",
  "ai", "ask", "tanya", "persona", "setpersona", "mypersona", "resetai", "cleari",
  "qr", "qrcode", "tr", "translate", "wiki", "wikipedia", "short", "shortlink",
  "cuaca", "weather", "calc", "sholat", "jadwalsholat", "surah", "quran",
  "dadu", "koin", "apakah", "siapakah", "rate", "kick", "remove", "promote",
  "demote", "mute", "unmute", "tagall", "hidetag", "linkgroup", "linkgc",
  "setname", "setdesc", "groupinfo", "ping", "owner", "runtime", "clearchat", "delchat", "hapuschat", "unlink", "putus", "disconnect", "listsesi", "sesi", "daftarsesi", "sessions", "tautkan", "relink", "switch", "pakaisesi", "hapussesi", "delsesi"
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
      console.log('2. Manajemen Sesi & Nomor WhatsApp:');
      console.log('   listsesi              : Lihat nomor-nomor yang pernah ditautkan');
      console.log('   tautkan <nomor>       : Hubungkan kembali ke nomor tersimpan (tanpa scan QR)');
      console.log('   unlink                : Putus tautan nomor sekarang & scan QR nomor baru');
      console.log('   hapussesi <nomor>     : Hapus arsip sesi nomor tertentu');
      console.log('3. Hapus semua riwayat chat nomor target (tanpa kirim pesan ke WA):');
      console.log('   clearchat <nomor>');
      console.log('   Contoh: clearchat 081234567890');
      console.log('3. Shortcut cepat (langsung ketik nomor lalu pesan):');
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

    // Perintah Manajemen Sesi dari Console Panel (bisa dijalankan kapan saja, bahkan saat scan QR)
    if (['listsesi', 'sesi', 'daftarsesi', 'sessions'].includes(cmd)) {
      const sessions = listSavedSessions();
      if (!sessions.length) {
        console.log('📋 [Console] Belum ada sesi yang tersimpan di saved_sessions/.');
      } else {
        console.log('\n================ DAFTAR SESI WHATSAPP TERSIMPAN ================');
        sessions.forEach((s, idx) => {
          const activeTag = s.isActive ? ' 🟢 [SEDANG AKTIF]' : ' ⚪ [Tersimpan]';
          console.log(`${idx + 1}. +${s.number} (${s.name})${activeTag}`);
        });
        console.log('---------------------------------------------------------------');
        console.log('👉 tautkan <nomor>   (Contoh: tautkan 085284907957)');
        console.log('👉 unlink            (Putus nomor sekarang & scan QR baru)');
        console.log('👉 hapussesi <nomor> (Hapus file sesi dari server)');
        console.log('===============================================================\n');
      }
      return;
    }

    if (['unlink', 'putus', 'disconnect', '.unlink', '.putus'].includes(cmd)) {
      console.log('⏳ [Console] Memutus tautan nomor bot saat ini...');
      const cur = getCurrentSessionInfo();
      if (cur.exists && cur.number) {
        backupCurrentSession();
        console.log(`💾 [Console] Sesi nomor +${cur.number} (${cur.name}) telah diamankan di saved_sessions.`);
      }
      clearActiveSession();
      console.log('🔄 [Console] Sesi aktif dikosongkan. Memulai ulang bot untuk menghasilkan QR Code baru...');
      await restartBotSession(2000);
      return;
    }

    if (['tautkan', 'relink', 'switch', 'pakaisesi', '.tautkan', '.switch'].includes(cmd)) {
      const targetNum = parts[1] || '';
      if (!targetNum) {
        console.log('⚠️ [Console] Masukkan nomor yang ingin ditautkan kembali.');
        console.log('   Contoh: tautkan 085284907957');
        console.log('   Ketik "listsesi" untuk melihat daftar nomor tersimpan.');
        return;
      }
      console.log(`⏳ [Console] Menyiapkan peralihan ke nomor ${targetNum}...`);
      const cur = getCurrentSessionInfo();
      if (cur.exists && cur.number) {
        backupCurrentSession();
      }
      const restored = restoreSession(targetNum);
      if (!restored.success) {
        console.error(`❌ [Console Gagal]: ${restored.error}`);
        return;
      }
      console.log(`✅ [Console Sukses] Berkas sesi nomor +${restored.number} (${restored.name}) berhasil dipulihkan.`);
      console.log('🔄 [Console] Menghubungkan ulang ke WhatsApp...');
      await restartBotSession(2000);
      return;
    }

    if (['hapussesi', 'delsesi'].includes(cmd)) {
      const targetNum = parts[1] || '';
      if (!targetNum) {
        console.log('⚠️ [Console] Masukkan nomor yang ingin dihapus sesinya. Contoh: hapussesi 081234567890');
        return;
      }
      const delRes = deleteSavedSession(targetNum);
      if (delRes.success) {
        console.log(`🗑️ [Console Sukses] Sesi nomor +${delRes.number} berhasil dihapus dari saved_sessions.`);
      } else {
        console.error(`❌ [Console Gagal]: ${delRes.error}`);
      }
      return;
    }

    if (!currentSock || !currentSock.user) {
      console.log('⚠️ [Console] Bot belum terhubung ke WhatsApp. Tunggu hingga login selesai atau scan QR.');
      return;
    }

    let targetRaw = '';
    let messageText = '';

    // Perintah clearchat langsung dari console panel
    if (['clearchat', '.clearchat', 'delchat', '.delchat', 'hapuschat', '.hapuschat'].includes(cmd)) {
      const targetInput = parts.slice(1).join(' ').trim();
      if (!targetInput) {
        console.log('⚠️ [Console] Masukkan nomor target untuk dihapus chat-nya.');
        console.log('   Contoh: clearchat 081234567890');
        return;
      }
      console.log(`⏳ [Console] Menghapus riwayat chat untuk nomor ${targetInput}...`);
      const result = await executeClearChat(currentSock, targetInput);
      if (result.success) {
        console.log(`🗑️ [Console Sukses] Aksi clear chat untuk nomor +${result.displayNum} diterima WhatsApp. Pesan bot yang ditarik: ${result.totalRevoked || 0} (tanpa mengirim pesan balasan).`);
      } else {
        console.error(`❌ [Console Gagal]: ${result.error || 'Terjadi kesalahan saat menghapus chat'}`);
      }
      return;
    }

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

    // Intercept clearchat agar tidak mengirim pesan teks ke WhatsApp
    const checkClearCmd = messageText.trim().replace(/^\./, '').split(/\s+/)[0].toLowerCase();
    const isTargetClear = ['clearchat', 'delchat', 'hapuschat'].includes(targetRaw.toLowerCase().replace(/^\./, ''));
    const isMsgClear = ['clearchat', 'delchat', 'hapuschat'].includes(checkClearCmd);

    if (isTargetClear || isMsgClear) {
      let finalTarget = isTargetClear ? messageText.trim() : (messageText.trim().replace(/^\.?\w+\s*/, '').trim() || targetRaw);
      console.log(`⏳ [Console] Menjalankan clearchat untuk ${finalTarget} tanpa mengirim pesan ke WhatsApp...`);
      const result = await executeClearChat(currentSock, finalTarget);
      if (result.success) {
        console.log(`🗑️ [Console Sukses] Aksi clear chat untuk nomor +${result.displayNum} diterima WhatsApp. Pesan bot yang ditarik: ${result.totalRevoked || 0}.`);
      } else {
        console.error(`❌ [Console Gagal]: ${result.error}`);
      }
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

          const firstParam = (targetRaw || '').toLowerCase().replace(/^\./, '');
          const secondParam = (messageText || '').trim();

          // Intercept session commands from CLI IPC
          if (['listsesi', 'sesi', 'daftarsesi', 'sessions'].includes(firstParam) || ['listsesi', 'sesi', 'daftarsesi', 'sessions'].includes(secondParam.toLowerCase().replace(/^\./, ''))) {
            const list = listSavedSessions();
            let summary = '';
            if (!list.length) {
              summary = 'Belum ada sesi nomor lain yang tersimpan.';
            } else {
              summary = 'Daftar sesi:\n' + list.map((s, idx) => `${idx + 1}. +${s.number} (${s.name})${s.isActive ? ' [AKTIF]' : ''}`).join('\n');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, isCommand: true, command: 'listsesi', replyText: summary, sessions: list }));
          }

          if (['unlink', 'putus', 'disconnect'].includes(firstParam) || ['unlink', 'putus', 'disconnect'].includes(secondParam.toLowerCase().replace(/^\./, ''))) {
            const cur = getCurrentSessionInfo();
            if (cur.exists && cur.number) {
              backupCurrentSession();
            }
            clearActiveSession();
            restartBotSession(2000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              isCommand: true,
              command: 'unlink',
              replyText: `Tautan nomor ${cur.number ? '+' + cur.number : ''} diputus. Bot restart dan membuat QR code baru.`
            }));
          }

          if (['tautkan', 'relink', 'switch', 'pakaisesi'].includes(firstParam)) {
            const num = secondParam;
            if (!num) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: false, error: 'Nomor target wajib disertakan. Contoh: send tautkan 085284907957' }));
            }
            const cur = getCurrentSessionInfo();
            if (cur.exists && cur.number) {
              backupCurrentSession();
            }
            const restored = restoreSession(num);
            if (!restored.success) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: false, error: restored.error }));
            }
            restartBotSession(2000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              isCommand: true,
              command: 'tautkan',
              replyText: `Sesi berhasil dialihkan ke nomor +${restored.number} (${restored.name}). Bot menghubungkan kembali.`
            }));
          }

          if (!currentSock || !currentSock.user) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Bot belum login atau belum terhubung ke WhatsApp.' }));
          }

          // Intercept clearchat agar tidak mengirim pesan teks ke WhatsApp
          const checkIpcClearCmd = (messageText || '').trim().replace(/^\./, '').split(/\s+/)[0].toLowerCase();
          const isIpcTargetClear = ['clearchat', 'delchat', 'hapuschat'].includes((targetRaw || '').toLowerCase().replace(/^\./, ''));
          const isIpcMsgClear = ['clearchat', 'delchat', 'hapuschat'].includes(checkIpcClearCmd);

          if (isIpcTargetClear || isIpcMsgClear) {
            let actualTarget = isIpcTargetClear ? messageText.trim() : (messageText.trim().replace(/^\.?\w+\s*/, '').trim() || (targetRaw !== 'me' && targetRaw !== 'self' ? targetRaw : ''));
            if (!actualTarget) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: false, error: 'Nomor target wajib diisi untuk clearchat.' }));
            }
            console.log(`⏳ [Terminal/CLI] Menjalankan clearchat untuk ${actualTarget} tanpa mengirim pesan ke WhatsApp...`);
            const result = await executeClearChat(currentSock, actualTarget);
            if (result.success) {
              console.log(`🗑️ [Terminal/CLI Sukses] Aksi clear chat nomor +${result.displayNum} diterima WhatsApp. Pesan bot yang ditarik: ${result.totalRevoked || 0}.`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: true,
                isCommand: true,
                command: 'clearchat',
                replyText: `Aksi clear chat nomor +${result.displayNum} diterima WhatsApp (tanpa pesan balasan). Pesan bot yang ditarik: ${result.totalRevoked || 0}.`
              }));
            } else {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: false, error: result.error }));
            }
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

let isRestartingSession = false;

async function restartBotSession(delayMs = 2000) {
  isRestartingSession = true;
  if (currentSock) {
    try {
      currentSock.ev.removeAllListeners();
      if (currentSock.ws) currentSock.ws.close();
      if (typeof currentSock.end === 'function') currentSock.end();
    } catch (e) {
      console.warn('[Session Manager] Catatan saat menutup socket lama:', e.message);
    }
    currentSock = null;
  }
  return new Promise((resolve) => {
    setTimeout(async () => {
      isRestartingSession = false;
      try {
        await startBot();
        resolve({ success: true });
      } catch (err) {
        console.error('[Session Manager] Gagal memulai ulang bot:', err);
        resolve({ success: false, error: err.message });
      }
    }, delayMs);
  });
}

async function startBot() {
  let state;
  let saveCreds;
  const mongoUri = process.env.MONGODB_URI;

  if (mongoUri) {
    // Load MongoDB only when configured so existing non-Mongo hosts still start.
    const { MongoClient } = require('mongodb');
    // Keep one client alive for the lifetime of the WhatsApp socket.
    const mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 15000 });
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DB || 'whatsapp_bot');
    const collection = db.collection(process.env.MONGODB_AUTH_COLLECTION || 'baileys_auth');
    const auth = await useMongoDBAuthState(collection, process.env.BAILEYS_SESSION_ID || 'main');
    state = auth.state;
    saveCreds = auth.saveCreds;
    console.log('[Auth] Sesi WhatsApp dimuat dari MongoDB.');
  } else {
    // Fallback untuk hosting lama/local yang belum mengatur MONGODB_URI.
    const sessionDir = path.resolve('./session');
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(sessionDir, 0o700); } catch {}
    const auth = await useMultiFileAuthState(sessionDir);
    state = auth.state;
    saveCreds = auth.saveCreds;
    console.log('[Auth] MONGODB_URI belum diatur, memakai sesi lokal ./session.');
  }
  const { version } = await fetchLatestBaileysVersion();

  console.log(`Menghubungkan WhatsApp Bot v${version.join('.')}...`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    msgRetryCounterCache,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 350,
    maxMsgRetryCount: 5,
    getMessage: async (key) => {
      if (key?.id) {
        const msg = messageStore.get(key.id);
        if (msg) return msg;
      }
      return undefined;
    }
  });

    const rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options) => {
    const result = await rawSendMessage(jid, content, options);
    if (result?.key && jid && !content?.react && !content?.delete) {
      trackSentBotMessage(jid, result.key);
      if (result.message && result.key.id) {
        storeMessage(result.key.id, result.message, jid);
      }
    }
    return result;
  };

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n================ SCAN QR CODE INI DI WHATSAPP ================');
      qrcode.generate(qr, { small: true });
      console.log('Buka WA di HP > Perangkat Tertaut > Tautkan Perangkat > Scan QR di atas\n');
    }

    if (connection === 'close') {
      currentSock = null;
      if (isRestartingSession) {
        console.log('[Session Manager] Koneksi lama ditutup untuk penggantian/pemutusan sesi.');
        return;
      }
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Koneksi terputus (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log('⚠️ Sesi logout dari WhatsApp (401). Mengosongkan sesi aktif dan menyiapkan QR Code baru...');
        clearActiveSession();
        setTimeout(startBot, 2000);
      }
    } else if (connection === 'open') {
      currentSock = sock;
      try {
        const bkp = backupCurrentSession();
        if (bkp.success) {
          console.log(`💾 [Session Manager] Sesi nomor +${bkp.number} (${bkp.name}) berhasil diamankan di saved_sessions.`);
        }
      } catch (e) {
        console.warn('[Session Manager] Gagal auto-backup:', e.message);
      }
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

  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      if (update.update?.message && update.key?.id) {
        storeMessage(update.key.id, update.update.message, update.key.remoteJid);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const sender = msg.key.remoteJid;
      const userKey = msg.key.participant || sender;
      const isFromMe = Boolean(msg.key.fromMe);

      if (msg.key?.id) {
        storeMessage(msg.key.id, msg.message, msg.key.remoteJid);
        trackChatMessage(msg);
        if (isFromMe && msg.key?.id && sender) trackSentBotMessage(sender, msg.key);
      }
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const rawMsg = unwrapMessage(msg);
      if (!rawMsg) continue;

      if (sender && sender.endsWith('@lid') && isFromMe) {
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
