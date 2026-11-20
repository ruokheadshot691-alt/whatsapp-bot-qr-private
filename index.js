require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  EmbedBuilder, 
  AttachmentBuilder, 
  ActivityType,
  PermissionsBitField,
  Events
} = require('discord.js');
const http = require('http');
const fs = require('fs');

// Auto-ekstrak modul voice jika arsip voice_modules.tar.gz tersedia
if (fs.existsSync(require("path").join(__dirname, "voice_modules.tar.gz"))) {
  try {
    const { execSync } = require("child_process");
    console.log("📦 Mengekstrak dependensi voice Discord...");
    if (!fs.existsSync(require("path").join(__dirname, "node_modules"))) {
      fs.mkdirSync(require("path").join(__dirname, "node_modules"), { recursive: true });
    }
    execSync("tar -xzf voice_modules.tar.gz -C node_modules", { cwd: __dirname, stdio: "inherit" });
    try { fs.unlinkSync(require("path").join(__dirname, "voice_modules.tar.gz")); } catch (_) {}
    console.log("✅ Dependensi voice Discord berhasil dipasang!");
  } catch (err) {
    console.error("Gagal ekstrak voice_modules.tar.gz:", err.message);
  }
}

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
  generateQrBuffer,
  generateAiImage
} = require('./src/tools');

const afkManager = require("./src/afk-manager");
const menfessManager = require("./src/menfess-manager");
const economyManager = require('./src/economy-manager');
const gamesManager = require('./src/games-manager');
const soundboardManager = require('./src/soundboard-manager');
const voicePlayer = Number(process.versions.node.split('.')[0]) >= 22 ? require('./src/voice-player') : null;
const { makeDiscordSticker, makeSticker, stickerToImage } = require('./src/sticker');
const { upscaleImage } = require('./src/hd');
const { makeBratSticker, makeBratVideoSticker } = require('./src/brat');
const {
  makeFakeTweet,
  makeAestheticQuote,
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
      const parsed = JSON.parse(fs.readFileSync(aiSettingsFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (!parsed.personas || typeof parsed.personas !== 'object') {
          parsed.personas = {};
        }
        return parsed;
      }
    }
  } catch (_) {}
  return { personas: {} };
}

function saveAiSettings(settings) {
  try {
    if (!settings || typeof settings !== 'object') settings = { personas: {} };
    if (!settings.personas || typeof settings.personas !== 'object') settings.personas = {};
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
const activeSusunKata = new Map();
const activeMathQuiz = new Map();

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
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Helper: Ekstrak buffer media dari attachment atau pesan balasan
async function getMediaBuffer(message, args = []) {
  const maxBytes = 25 * 1024 * 1024;
  const download = async (url, contentType, name) => {
    const res = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 30000,
      maxContentLength: maxBytes, maxBodyLength: maxBytes
    });
    const buffer = Buffer.from(res.data);
    if (buffer.length > maxBytes) throw new Error('File audio melebihi batas 25 MB.');
    return { buffer, contentType, name };
  };

  if (message.attachments && message.attachments.size > 0) {
    const att = message.attachments.first();
    if (att.size && att.size > maxBytes) throw new Error('File audio melebihi batas 25 MB.');
    return await download(att.url, att.contentType, att.name);
  }

  if (message.reference && message.reference.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg && refMsg.attachments && refMsg.attachments.size > 0) {
        const att = refMsg.attachments.first();
        if (att.size && att.size > maxBytes) throw new Error('File audio melebihi batas 25 MB.');
        return await download(att.url, att.contentType, att.name);
      }
    } catch (err) { if (err.message.includes('25 MB')) throw err; }
  }

  if (args[0] && /^https?:\/\//i.test(args[0])) {
    const url = new URL(args[0]);
    if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
      throw new Error('Link harus dari Discord CDN; tautan eksternal tidak didukung.');
    }
    return await download(url.href, null, 'downloaded-audio');
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

// Helper: Parse custom profile (Display Name, Username, Avatar, Teks) untuk .tweet dan .quote
async function parseCustomProfileInput({ message, args, rawArgsText, refMsg }) {
  let customName = null;
  let customUsername = null;
  let customAvatarUrl = null;
  let text = '';
  let isCustom = false;

  const flagRegex = /(?:--|-)(name|nama|n|user|username|u|avatar|pfp|foto|pic)\b/i;
  if (flagRegex.test(rawArgsText)) {
    let remaining = rawArgsText;
    const nameMatch = remaining.match(/(?:--|-)(?:name|nama|n)\s+("[^"]+"|\S+)/i);
    if (nameMatch) {
      customName = nameMatch[1].replace(/^"|"$/g, '').trim();
      remaining = remaining.replace(nameMatch[0], ' ');
    }
    const userMatch = remaining.match(/(?:--|-)(?:username|user|u)\s+("[^"]+"|\S+)/i);
    if (userMatch) {
      customUsername = userMatch[1].replace(/^"|"$/g, '').replace(/^@/, '').trim();
      remaining = remaining.replace(userMatch[0], ' ');
    }
    const avatarMatch = remaining.match(/(?:--|-)(?:avatar|pfp|foto|pic)\s+("[^"]+"|\S+)/i);
    if (avatarMatch) {
      customAvatarUrl = avatarMatch[1].replace(/^"|"$/g, '').trim();
      remaining = remaining.replace(avatarMatch[0], ' ');
    }
    text = remaining.trim();
    isCustom = !!(customName || customUsername || customAvatarUrl);
  } else if (rawArgsText.includes('|')) {
    const parts = rawArgsText.split('|').map(p => p.trim());
    if (parts.length >= 3) {
      customName = parts[0];
      customUsername = parts[1].replace(/^@/, '');
      if (parts.length >= 4 && /^https?:\/\//i.test(parts[2])) {
        customAvatarUrl = parts[2];
        text = parts.slice(3).join('|').trim();
      } else {
        text = parts.slice(2).join('|').trim();
      }
      isCustom = true;
    } else if (parts.length === 2) {
      customName = parts[0];
      customUsername = parts[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 15) || 'user';
      text = parts[1];
      isCustom = true;
    }
  }

  let targetUser = message ? message.author : null;
  if (!isCustom) {
    if (message && message.mentions && message.mentions.users && message.mentions.users.size > 0) {
      targetUser = message.mentions.users.first();
      const textParts = args.filter(a => !a.startsWith('<@'));
      text = textParts.join(' ');
      if (!text && refMsg && refMsg.content) {
        text = refMsg.content;
      }
    } else if (refMsg) {
      targetUser = refMsg.author;
      text = args.length > 0 ? args.join(' ') : (refMsg.content || '');
    } else if (message) {
      targetUser = message.author;
      text = args.join(' ');
    }
  }

  let avatarBuffer = null;
  if (customAvatarUrl && /^https?:\/\//i.test(customAvatarUrl)) {
    try {
      const res = await axios.get(customAvatarUrl, { responseType: 'arraybuffer', timeout: 8000 });
      if (res.status === 200 && res.data) avatarBuffer = Buffer.from(res.data);
    } catch (_) {}
  }

  if (!avatarBuffer && message && message.attachments && message.attachments.size > 0) {
    const att = message.attachments.first();
    if (!att.contentType || att.contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(att.url)) {
      try {
        const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 8000 });
        if (res.status === 200 && res.data) avatarBuffer = Buffer.from(res.data);
      } catch (_) {}
    }
  }

  if (!avatarBuffer && refMsg && refMsg.attachments && refMsg.attachments.size > 0) {
    const att = refMsg.attachments.first();
    if (!att.contentType || att.contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(att.url)) {
      try {
        const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 8000 });
        if (res.status === 200 && res.data) avatarBuffer = Buffer.from(res.data);
      } catch (_) {}
    }
  }

  if (!avatarBuffer && !isCustom && targetUser && typeof targetUser.displayAvatarURL === 'function') {
    try {
      const avUrl = targetUser.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
      const res = await axios.get(avUrl, { responseType: 'arraybuffer', timeout: 8000 });
      if (res.status === 200 && res.data) avatarBuffer = Buffer.from(res.data);
    } catch (_) {}
  }

  const finalName = customName || (targetUser ? (targetUser.displayName || targetUser.username || 'User') : 'User');
  const finalUsername = customUsername || (targetUser ? (targetUser.username || 'user') : 'user');

  return {
    isCustom,
    name: finalName,
    username: finalUsername,
    text: text.trim(),
    avatarBuffer
  };
}

// Format label gelar yang muncul langsung di nickname server
function formatTitleBadge(titleText) {
  if (!titleText) return '';
  const badges = {
    '💎 Konglomerat Server': 'Konglomerat💎',
    '👑 Sultan Server': 'Sultan👑',
    '🎲 Raja Judi': 'Raja Judi🎲',
    '🔥 Lord Tuff': 'Lord Tuff🔥'
  };
  return badges[titleText] || String(titleText).trim().replace(/\s+server$/i, '').trim();
}

function getNicknameBase(member) {
  const current = (member.nickname || member.user.displayName || member.user.username || 'User').trim();
  const bracketed = current.match(/^\[(.*?)\](?:\s+.*)?$/u);
  if (bracketed && bracketed[1]) return bracketed[1].trim();
  return current.replace(/\s+(?:Konglomerat💎|Sultan👑|Raja Judi🎲|Lord Tuff🔥)$/u, '').trim();
}

function buildTitleNickname(member, titleText) {
  const badge = formatTitleBadge(titleText);
  if (!badge) return null;
  const prefix = '[';
  const suffix = `] ${badge}`;
  const available = Math.max(1, 32 - Array.from(prefix + suffix).length);
  const base = Array.from(getNicknameBase(member)).slice(0, available).join('').trim();
  return `${prefix}${base || 'User'}${suffix}`;
}

async function syncDiscordTitleNickname(guild, member, titleText) {
  const nickname = buildTitleNickname(member, titleText);
  if (!guild || !member || !nickname) return { success: false, reason: 'Tidak bisa menentukan nickname gelar.' };
  if (guild.ownerId === member.id) {
    return { success: false, reason: `Discord tidak mengizinkan bot mengubah nickname pemilik server. Pasang manual: \`${nickname}\`.` };
  }
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
    return { success: false, reason: 'Bot perlu izin Manage Nicknames (Kelola Nama Panggilan).' };
  }
  if (botMember.roles.highest.position <= member.roles.highest.position) {
    return { success: false, reason: 'Role bot harus diposisikan di atas role tertinggi kamu.' };
  }
  try {
    await member.setNickname(nickname, `Gelar ekonomi: ${formatTitleBadge(titleText)}`);
    return { success: true, nickname };
  } catch (err) {
    return { success: false, reason: `Gagal mengubah nickname: ${err.message}` };
  }
}

async function resetDiscordTitleNickname(guild, member) {
  if (!guild || !member || guild.ownerId === member.id) return;
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames) || botMember.roles.highest.position <= member.roles.highest.position) return;
  const base = getNicknameBase(member);
  try {
    await member.setNickname(base === member.user.username ? null : base.substring(0, 32), 'Gelar ekonomi dilepas');
  } catch (_) {}
}

// Sinkronisasi Role Discord untuk Gelar Toko Koin
async function syncDiscordTitleRole(guild, member, titleText, colorHex) {
  if (!guild || !member) return { success: false, reason: 'Bukan di dalam server Discord.' };

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return {
      success: false,
      reason: 'Bot belum diberi izin `Manage Roles` (Kelola Peran) di server ini.'
    };
  }

  const roleName = String(titleText || '').trim().substring(0, 100);
  if (!roleName) return { success: false, reason: 'Nama gelar kosong.' };

  let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) {
    try {
      role = await guild.roles.create({
        name: roleName,
        color: colorHex || 0xFEE75C,
        hoist: true,
        reason: `Gelar toko koin oleh ${member.user.tag}`
      });
    } catch (err) {
      return { success: false, reason: `Gagal membuat role: ${err.message}` };
    }
  }

  if (botMember.roles.highest.position <= role.position) {
    return {
      success: false,
      reason: 'Posisi role bot di Server Settings > Roles berada di bawah role ini. Tarik role bot ke posisi lebih atas.'
    };
  }

  try {
    await member.roles.add(role);
    return { success: true, role };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function removeDiscordTitleRole(guild, member, titleText) {
  if (!guild || !member || !titleText) return;
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
  const roleName = String(titleText).substring(0, 100).toLowerCase();
  const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName);
  if (role && member.roles.cache.has(role.id) && botMember.roles.highest.position > role.position) {
    await member.roles.remove(role).catch(() => null);
  }
}

// Helper Manajemen & Verifikasi Owner Bot
function getCustomOwners() {
  try {
    const ownersFile = path.join(__dirname, 'data', 'owners.json');
    if (fs.existsSync(ownersFile)) {
      const parsed = JSON.parse(fs.readFileSync(ownersFile, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
      if (parsed.owners && Array.isArray(parsed.owners)) return parsed.owners;
    }
  } catch (_) {}
  return [];
}

function saveCustomOwners(ownersList) {
  try {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ownersFile = path.join(dir, 'owners.json');
    fs.writeFileSync(ownersFile, JSON.stringify(ownersList, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Gagal menyimpan data/owners.json:', err.message);
    return false;
  }
}

function isBotOwner(message) {
  if (!message || !message.author) return false;
  const authorId = message.author.id;
  if (!authorId) return false;

  // 1. Eksekusi via console IPC (send.js)
  if (authorId === 'console-owner' || message.isConsole) return true;

  // 2. ID dari config.ownerId
  if (config.ownerId) {
    const configured = String(config.ownerId).split(',').map(s => s.trim()).filter(Boolean);
    if (configured.includes(authorId)) return true;
  }

  // 3. ID dari data/owners.json
  const customOwners = getCustomOwners();
  if (customOwners.includes(authorId)) return true;

  // 4. Discord Application Owner (User / Team)
  const appOwner = client.application?.owner;
  if (appOwner) {
    if (appOwner.id && appOwner.id === authorId) return true;
    if (appOwner.ownerId && appOwner.ownerId === authorId) return true;
    if (appOwner.members && typeof appOwner.members.has === 'function' && appOwner.members.has(authorId)) return true;
  }

  // 5. Fallback jika config.ownerId belum diatur: pemilik server (Guild Owner)
  if (!config.ownerId && customOwners.length === 0 && message.guild && message.guild.ownerId === authorId) {
    return true;
  }

  return false;
}

// Parser jumlah angka fleksibel (mendukung 100k, 1.5m, 1jt, dll)
function parseCoinAmount(str) {
  if (!str) return NaN;
  let clean = String(str).toLowerCase().trim();
  const match = clean.match(/^(\d+(?:[.,]\d+)?)\s*(k|rb|ribu|m|jt|juta|b|miliar)$/);
  if (match) {
    const val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2];
    if (['k', 'rb', 'ribu'].includes(unit)) return Math.floor(val * 1000);
    if (['m', 'jt', 'juta'].includes(unit)) return Math.floor(val * 1000000);
    if (['b', 'miliar'].includes(unit)) return Math.floor(val * 1000000000);
  }
  clean = clean.replace(/[,._]/g, '');
  if (/^\d+$/.test(clean)) return Number(clean);
  return NaN;
}

// Core Command Handler: Dapat dipanggil dari Discord chat maupun console CLI
async function handleCommand({ message, command, args, rawText }) {
  const prefix = config.prefix || '.';

  // Handling Menfess via DM
  if (!message.guild) {
    const isMenfess = message.content.startsWith(prefix + 'menfess') || message.content.startsWith(prefix + 'confess');
    if (isMenfess) {
      const rawArgs = message.content.slice(prefix.length).trim().split(/\s+/);
      const textMsg = rawArgs.slice(1).join(' ').trim();
      let mediaUrl = null;
      if (message.attachments && message.attachments.size > 0) {
        const att = message.attachments.first();
        if (!att.contentType || att.contentType.startsWith('image/')) {
          mediaUrl = att.url;
        }
      }

      if (!textMsg && !mediaUrl) {
        return await message.reply({
          content: `💌 **Format Kirim Menfess via DM:**\nKetik: \`${prefix}menfess <pesan curhat kamu>\` (bisa lampirkan gambar jika mau).\nPesan akan dikirimkan secara anonim ke channel menfess server tanpa membocorkan identitasmu!`
        });
      }

      const allConfigs = menfessManager.getAllConfigs();
      let targetGuild = null;
      let targetChannelId = null;

      for (const [gid, cfg] of Object.entries(allConfigs)) {
        if (cfg && cfg.channelId) {
          const g = client.guilds.cache.get(gid);
          if (g) {
            targetGuild = g;
            targetChannelId = cfg.channelId;
            break;
          }
        }
      }

      if (!targetGuild || !targetChannelId) {
        return await message.reply({
          content: '❌ Belum ada channel menfess yang diatur di server! Minta Admin server mengetik `.setmenfess #channel` terlebih dahulu.'
        });
      }

      const destChannel = targetGuild.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch(() => null);
      if (!destChannel) {
        return await message.reply({ content: '❌ Channel tujuan menfess tidak ditemukan atau bot tidak memiliki izin mengaksesnya.' });
      }

      const count = menfessManager.incrementAndGetCount(targetGuild.id);
      const embed = menfessManager.buildMenfessEmbed({ count, text: textMsg, mediaUrl });
      await destChannel.send({ embeds: [embed] });

      return await message.reply({
        content: `✅ Menfess kamu berhasil terkirim secara anonim sebagai **#${String(count).padStart(3, '0')}** ke channel **#${destChannel.name}** di server **${targetGuild.name}**!`
      });
    }
  }

  // Handling AFK jika pesan di server
  if (message.guild) {
    // 1. Cek apakah pengirim pesan sedang AFK
    const senderAfk = afkManager.getAfk(message.author.id);
    const isAfkSettingCommand = message.content.startsWith(prefix + 'afk');

    if (senderAfk && !isAfkSettingCommand) {
      const oldAfk = afkManager.removeAfk(message.author.id);
      const duration = afkManager.formatDuration(Date.now() - oldAfk.timestamp);

      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('👋 Status AFK Dicabut')
        .setDescription(`Selamat datang kembali **${message.author.displayName || message.author.username}**! Status AFK kamu telah dinonaktifkan.\n⏱️ Kamu AFK selama **${duration}**.`)
        .setTimestamp();

      if (oldAfk.mentions && oldAfk.mentions.length > 0) {
        const mentionList = oldAfk.mentions.slice(-5).map((m, idx) => {
          return `**${idx + 1}.** Dari **${m.authorTag}** di <#${m.channelId}>:\n> "${m.content}" ${m.url ? `([Lompat ke Pesan](${m.url}))` : ''}`;
        }).join('\n');

        welcomeEmbed.addFields({
          name: `📬 Pesan yang Mencari Kamu (${oldAfk.mentions.length} total)`,
          value: mentionList.slice(0, 1024)
        });
      }

      await message.reply({ embeds: [welcomeEmbed] }).catch(() => {});
    }

    // 2. Cek apakah ada member AFK yang di-mention oleh pesan ini
    if (message.mentions && message.mentions.users && message.mentions.users.size > 0) {
      for (const [mUserId, mUser] of message.mentions.users) {
        if (mUser.bot || mUserId === message.author.id) continue;
        const targetAfk = afkManager.getAfk(mUserId);
        if (targetAfk) {
          afkManager.recordMention(mUserId, {
            authorTag: message.author.displayName || message.author.username,
            authorId: message.author.id,
            channelName: message.channel.name,
            channelId: message.channel.id,
            content: message.content.slice(0, 180),
            url: message.url,
            timestamp: Date.now()
          });

          const durationAgo = afkManager.formatDuration(Date.now() - targetAfk.timestamp);
          await message.reply({
            content: `💤 **${mUser.displayName || mUser.username}** sedang **AFK**: *${targetAfk.reason}* (${durationAgo} yang lalu). Pesanmu sudah dicatat!`
          }).catch(() => {});
          break;
        }
      }
    }
  }

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
              `\`${prefix}resetai\` - Bersihkan memori chat AI`,
              `\`${prefix}aiimg <prompt>\` - Buat gambar estetik berbasis AI (Flux Engine)`
            ].join('\n')
          },
          {
            name: '🎨 Stiker & Olah Media',
            value: [
              `\`${prefix}s [nama]\` - Buat stiker dan simpan otomatis ke server Discord`,
              `\`${prefix}liststicker\` - Lihat stiker server dan slot tersisa`,
              `\`${prefix}delsticker <nama/ID>\` - Hapus stiker custom dari server`,
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
              `\`${prefix}play [nama/durasi] [mulai_detik]\` - Streaming audio panjang di VC`,
              `\`${prefix}savesound <nama> [durasi] [mulai_detik]\` - Simpan audio kustom`,
              `\`${prefix}listsounds\` - Lihat library audio kustom`,
              `\`${prefix}stopvc\` - Hentikan audio dan keluarkan bot dari VC`,
              `\`${prefix}addsound <nama> [detik]\` - Buat klip Soundboard resmi (maks 5 detik)`,
              `\`${prefix}listsound\` / \`${prefix}delsound <nama>\` - Kelola Soundboard resmi`,
              `\`${prefix}tts <teks>\` - Ubah teks menjadi suara Google (MP3)`,
              `\`${prefix}tomp3\` - Reply video untuk diekstrak jadi audio MP3`,
              `\`${prefix}bass\`, \`${prefix}slow\`, \`${prefix}robot\` - Efek audio`
            ].join('\n')
          },
          {
            name: '🎭 Fake Tweet & Aesthetic Quote',
            value: [
              `\`${prefix}tweet <teks / custom>\` - Postingan X/Twitter (custom nama, @user, foto profil)`,
              `\`${prefix}quote <teks / custom>\` - Poster kutipan kata bijak aesthetic dark neon`
            ].join('\n')
          },
          {
            name: '💬 Komunitas, AFK & Menfess',
            value: [
              `\`${prefix}afk [alasan]\` - Pasang status AFK & rangkum pesan saat offline`,
              `\`${prefix}menfess <pesan>\` - Kirim pesan curhat/confession anonim (+foto)`,
              `\`${prefix}menfess dm @user <pesan>\` - Kirim pesan rahasia langsung ke DM orang`,
              `\`${prefix}setmenfess <#channel>\` - Atur channel tujuan menfess server (Admin)`
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
            name: '💰 Ekonomi & Penghasilan',
            value: [
              `\`${prefix}bal\` - Cek saldo dompet, bank, streak & efek buff`,
              `\`${prefix}daily\` - Klaim koin harian (Bonus Streak & Hadiah)`,
              `\`${prefix}work\` - Bekerja halal mencari nafkah (cooldown 30m)`,
              `\`${prefix}crime\` - Aksi kejahatan berisiko (reward besar)`,
              `\`${prefix}beg\` - Mengemis recehan santai (cooldown 5m)`,
              `\`${prefix}mancing\` - Memancing ikan & harta karun samudra`,
              `\`${prefix}mining\` - Menambang mineral emas, berlian & zamrud`,
              `\`${prefix}jual [all]\` - Jual hasil pancingan & tambang jadi koin`,
              `\`${prefix}dep\` / \`${prefix}wd\` - Simpan & tarik koin di bank`,
              `\`${prefix}pay @user <jml>\` - Kirim koin ke teman`,
              `\`${prefix}rob @user\` - Coba rampok dompet member lain`,
              `\`${prefix}rich\` - Papan peringkat member terkaya server`
            ].join('\n')
          },
          {
            name: '🛒 Toko & Hadiah Koin',
            value: [
              `\`${prefix}shop\` - Katalog 16+ item, alat, buff & gelar`,
              `\`${prefix}buy <id>\` - Beli item / alat bantu / gelar Discord`,
              `\`${prefix}inv\` - Cek inventaris & isi ransel kamu`,
              `\`${prefix}use <id>\` - Pakai item konsumsi / Mystery Box`,
              `\`${prefix}settitle <gelar>\` - Pasang custom gelar profil & role`,
              `\`${prefix}syncgelar\` - Pasang ulang role gelar di server`,
              `\`${prefix}copotgelar\` - Lepas gelar & role kehormatan`,
              `\`${prefix}lotre\` - Beli tiket & pantau jackpot server`,
              `\`${prefix}gift @user [pesan]\` - Kirim kado koin ke teman`,
              `\`${prefix}prank @user\` - Lemparkan bom tepung ke teman`
            ].join('\n')
          },
          {
            name: '🎲 Mini Games & Kasino Hiburan',
            value: [
              `\`${prefix}slot <taruhan/all>\` - Mesin slot kasino 777 (Jackpot s/d 10x!)`,
              `\`${prefix}rolet <pilihan> <taruhan>\` - Rolet kasino (Merah/Hitam 2x, Angka 36x!)`,
              `\`${prefix}bj <taruhan/all>\` - Permainan kartu Blackjack 21 vs Dealer`,
              `\`${prefix}pacuankuda <1-5> <taruhan>\` - Balap kuda pacu seru (Payout 4x!)`,
              `\`${prefix}mines <1-5 ranjau> <taruhan>\` - Tebak petak ranjau (Multiplier s/d 5.5x!)`,
              `\`${prefix}suit <batu/gunting/kertas> [taruhan]\` - Duel suit vs bot bertaruh koin`,
              `\`${prefix}dadu [taruhan]\` - Lempar dadu kasual atau duel taruhan vs bot`,
              `\`${prefix}cf <pilihan> [taruhan]\` - Coinflip koin (gambar/angka / benar/salah)`,
              `\`${prefix}tebakangka <1-10> <taruhan>\` - Tebak angka rahasia (Payout 5x!)`,
              `\`${prefix}math\` / \`${prefix}hitung\` - Kuis hitung cepat rebutan koin di chat`,
              `\`${prefix}susunkata\` / \`${prefix}tebakkata\` - Kuis tebak kata berhadiah koin`,
              `\`${prefix}apakah\` / \`${prefix}rate\` / \`${prefix}siapakah\` - Game santai & lucu`
            ].join('\n')
          },
          {
            name: '⚙️ Info Bot',
            value: `\`${prefix}ping\` | \`${prefix}runtime\` | \`${prefix}owner\``
          }
        )
        .setFooter({ text: `${config.botName} • Semua Fitur Telah Dikembalikan Lengkap`, iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

      if (isBotOwner(message)) {
        embed.addFields({
          name: '👑 Menu Khusus Owner Bot',
          value: [
            `\`${prefix}addcoin [@user / me] <jml> [bank]\` - Beri koin ke siapa saja / diri sendiri`,
            `\`${prefix}delcoin [@user / me] <jml> [bank]\` - Tarik / kurangi koin member`,
            `\`${prefix}setcoin [@user / me] <jml> [bank]\` - Atur saldo koin spesifik`,
            `\`${prefix}addowner @user\` - Tambah co-owner bot resmi`
          ].join('\n')
        });
      }

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
      const customList = getCustomOwners();
      const appOwner = client.application?.owner;
      const ownersSet = new Set();
      if (config.ownerId) String(config.ownerId).split(',').map(s => s.trim()).filter(Boolean).forEach(id => ownersSet.add(id));
      customList.forEach(id => ownersSet.add(id));
      if (appOwner) {
        if (appOwner.id) ownersSet.add(appOwner.id);
        if (appOwner.ownerId) ownersSet.add(appOwner.ownerId);
      }
      const ownerTags = ownersSet.size > 0 ? Array.from(ownersSet).map(id => `<@${id}>`).join(', ') : (config.ownerId ? `<@${config.ownerId}>` : 'Belum diatur');

      const isCallerOwner = isBotOwner(message);
      let text = `👑 **Owner Bot Resmi:** ${ownerTags}\n\n`;
      if (isCallerOwner) {
        text += `✨ **Kamu terverifikasi sebagai Owner Bot!**\n` +
          `• \`${prefix}addcoin <jumlah>\` — Tambah koin ke diri sendiri\n` +
          `• \`${prefix}addcoin @user <jumlah>\` — Beri koin ke member lain\n` +
          `• \`${prefix}delcoin [@user / me] <jumlah>\` — Kurangi koin\n` +
          `• \`${prefix}setcoin [@user / me] <jumlah>\` — Setel jumlah koin\n` +
          `• \`${prefix}addowner @user\` — Tambahkan co-owner bot`;
      } else {
        text += `ℹ️ Hubungi owner bot jika kamu membutuhkan bantuan atau koin.`;
      }
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
      const userPersona = (settings.personas && settings.personas[userId]) || '';
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

      if (!settings.personas) settings.personas = {};

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
      const current = settings.personas ? settings.personas[userId] : null;
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

    case 'aiimg':
    case 'imagine':
    case 'dalle':
    case 'genimg':
    case 'txt2img':
    case 'imageai': {
      const prompt = await getContextText(message, args);
      if (!prompt) {
        const text = `⚠️ Masukkan deskripsi gambar yang ingin dibuat!\nContoh: \`${prefix}aiimg cyber samurai in neo tokyo 4k anime\` atau reply pesan teks.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      if (message.channel && message.channel.sendTyping) {
        message.channel.sendTyping().catch(() => {});
      }

      let waitMsg = null;
      try {
        waitMsg = await message.reply({ content: `🎨 Sedang membuat gambar AI untuk prompt: *"${prompt}"*...\n_Mohon tunggu sebentar ya..._` });
      } catch {}

      try {
        const imgBuffer = await generateAiImage(prompt);
        const attachment = new AttachmentBuilder(imgBuffer, { name: 'ai_generated.jpg' });

        await message.reply({
          content: `✨ **Hasil AI Image Generator (Flux)**\nPrompt: *${prompt}*\nDiminta oleh: <@${userId}>`,
          files: [attachment]
        });

        if (waitMsg && waitMsg.delete) {
          waitMsg.delete().catch(() => {});
        }

        replyTextOutput = `[AI Image Generated: ${prompt}]`;
      } catch (err) {
        const errText = `❌ Gagal membuat gambar AI: ${err.message}`;
        if (waitMsg && waitMsg.edit) {
          await waitMsg.edit({ content: errText }).catch(() => message.reply({ content: errText }));
        } else {
          await message.reply({ content: errText });
        }
        replyTextOutput = errText;
      }
      break;
    }

    // --- STIKER & OLAH MEDIA ---
    case 's':
    case 'sticker':
    case 'stiker': {
      const media = await getMediaBuffer(message, args);
      if (!media) {
        const text = `⚠️ Kirim gambar dengan perintah \`${prefix}s [nama_stiker]\` atau reply gambar/stiker yang ada. Contoh: \`${prefix}s kucing_lucu\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      if (!message.guild) {
        const text = `⚠️ Untuk menyimpan stiker ke server, jalankan perintah ini di channel server Discord.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
      const canManageStickers = botMember && botMember.permissions.has(PermissionsBitField.Flags.ManageEmojisAndStickers);
      if (!canManageStickers) {
        const text = `❌ Bot perlu izin **Manage Expressions** (Manage Emojis and Stickers) di server ini untuk membuat stiker.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      let maxStickers = 5;
      if (message.guild.premiumTier === 1) maxStickers = 15;
      else if (message.guild.premiumTier === 2) maxStickers = 30;
      else if (message.guild.premiumTier >= 3) maxStickers = 60;

      const currentStickers = await message.guild.stickers.fetch().catch(() => message.guild.stickers.cache);
      if (currentStickers.size >= maxStickers) {
        const text = `⚠️ Slot stiker server penuh (${currentStickers.size}/${maxStickers}). Hapus stiker lama dengan \`${prefix}delsticker <nama atau ID>\` atau kosongkan slot terlebih dahulu.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }

      const rawName = args.join(' ').trim() || `stiker-${message.author.username}`;
      let stickerName = rawName.replace(/[^a-zA-Z0-9_ -]/g, '').trim().slice(0, 30);
      if (stickerName.length < 2) stickerName = `stiker-${message.author.id.slice(-8)}`;
      const tags = stickerName.toLowerCase().replace(/[ -]+/g, '_').slice(0, 30) || 'sticker';
      const loading = await message.reply({ content: '⏳ Mengubah gambar ke format stiker Discord dan menyimpannya ke server…' });

      try {
        const pngBuffer = await makeDiscordSticker(media.buffer);
        const created = await message.guild.stickers.create({
          file: pngBuffer,
          name: stickerName,
          tags,
          description: `Dibuat oleh ${message.author.username}`.slice(0, 100),
          reason: `Stiker dibuat lewat perintah ${prefix}s oleh ${message.author.tag}`
        });
        const attachment = new AttachmentBuilder(pngBuffer, { name: `${stickerName}.png` });
        await loading.edit({
          content: `✅ Stiker **${created.name}** berhasil ditambahkan ke server **${message.guild.name}**. Stiker sekarang tersedia di pemilih stiker server.`,
          files: [attachment]
        });
        replyTextOutput = `[Stiker server dibuat: ${created.name}]`;
      } catch (err) {
        let reason = err.message || 'Kesalahan tidak diketahui';
        if (err.code === 30039) reason = 'slot stiker server sudah penuh';
        if (err.code === 50013) reason = 'bot tidak punya izin Manage Expressions';
        if (err.code === 50035) reason = 'Discord menolak format/nama stiker; coba gambar PNG/JPG dan nama lain';
        const text = `❌ Tidak berhasil menyimpan stiker ke server: ${reason}`;
        await loading.edit({ content: text }).catch(() => message.reply({ content: text }));
        replyTextOutput = text;
      }
      break;
    }

    case 'liststicker':
    case 'stickers':
    case 'daftarstiker': {
      if (!message.guild) {
        const text = '⚠️ Perintah ini hanya bisa digunakan di server.';
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      const stickers = await message.guild.stickers.fetch().catch(() => message.guild.stickers.cache);
      const maxStickers = message.guild.premiumTier >= 3 ? 60 : message.guild.premiumTier === 2 ? 30 : message.guild.premiumTier === 1 ? 15 : 5;
      const list = stickers.map(sticker => `• **${sticker.name}** (ID: \`${sticker.id}\`, tag: \`${sticker.tags}\`)`).join('\n') || 'Belum ada stiker custom.';
      const embed = new EmbedBuilder().setColor(config.embedColor || 0x5865F2).setTitle(`Stiker server: ${message.guild.name}`).setDescription(`Slot terpakai: ${stickers.size}/${maxStickers}\n\n${list}`);
      await message.reply({ embeds: [embed] });
      replyTextOutput = `[Daftar stiker server: ${stickers.size}/${maxStickers}]`;
      break;
    }

    case 'delsticker':
    case 'removesticker':
    case 'hapusstiker': {
      if (!message.guild) {
        const text = '⚠️ Perintah ini hanya bisa digunakan di server.';
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageEmojisAndStickers)) {
        const text = '❌ Kamu perlu izin **Manage Expressions** untuk menghapus stiker server.';
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      const query = args.join(' ').trim();
      if (!query) {
        const text = `⚠️ Pakai \`${prefix}delsticker <nama atau ID>\`.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      const stickers = await message.guild.stickers.fetch().catch(() => message.guild.stickers.cache);
      const target = stickers.find(sticker => sticker.id === query || sticker.name.toLowerCase() === query.toLowerCase());
      if (!target) {
        const text = `❌ Stiker \`${query}\` tidak ditemukan. Lihat dengan \`${prefix}liststicker\`.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        return replyTextOutput;
      }
      try {
        const name = target.name;
        await target.delete(`Dihapus oleh ${message.author.tag}`);
        const text = `🗑️ Stiker **${name}** dihapus dari server.`;
        await message.reply({ content: text });
        replyTextOutput = text;
      } catch (err) {
        const text = `❌ Gagal menghapus stiker: ${err.message}`;
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

    // --- FAKE TWEET & MEME CANVAS ---
    case 'tweet':
    case 'faketweet':
    case 'twit':
    case 'x': {
      let refMsg = null;
      if (message.reference && message.reference.messageId) {
        try {
          refMsg = await message.channel.messages.fetch(message.reference.messageId);
        } catch (_) {}
      }

      const rawArgsText = args.join(' ');
      const parsed = await parseCustomProfileInput({ message, args, rawArgsText, refMsg });

      if (!parsed.text) {
        const helpText = `🐦 **Format Fake Tweet (${prefix}tweet / ${prefix}x)**:\n` +
          `• **Custom Penuh (Pipe):** \`${prefix}tweet Display Name | @username | Teks tweet\`\n` +
          `• **Custom Foto (Link):** \`${prefix}tweet Display Name | @username | Link_Foto | Teks\`\n` +
          `• **Custom Foto (Upload):** Lampirkan foto lalu ketik \`${prefix}tweet Display Name | @username | Teks\`\n` +
          `• **Custom Flag:** \`${prefix}tweet -name "Elon Musk" -user elonmusk Teks tweet\`\n` +
          `• **Mention Teman:** \`${prefix}tweet @user Teks tweet\`\n` +
          `• **Reply Pesan:** Reply chat teman lalu ketik \`${prefix}tweet\`\n` +
          `• **Tweet Sendiri:** \`${prefix}tweet Teks tweet kamu\``;
        await message.reply({ content: helpText });
        replyTextOutput = helpText;
        return replyTextOutput;
      }

      try {
        const tweetBuf = await makeFakeTweet({
          name: parsed.name,
          username: parsed.username,
          text: parsed.text,
          avatarBuffer: parsed.avatarBuffer
        });

        const attachment = new AttachmentBuilder(tweetBuf, { name: 'tweet.png' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Fake Tweet Terkirim]';
      } catch (err) {
        console.error('[TWEET] Error:', err);
        await message.reply({ content: `❌ Gagal membuat fake tweet: ${err.message}` });
      }
      break;
    }

    // --- AESTHETIC DARK QUOTE GENERATOR ---
    case 'quote':
    case 'quotes':
    case 'kata':
    case 'katabijak':
    case 'q': {
      let refMsg = null;
      if (message.reference && message.reference.messageId) {
        try {
          refMsg = await message.channel.messages.fetch(message.reference.messageId);
        } catch (_) {}
      }

      const rawArgsText = args.join(' ');
      const parsed = await parseCustomProfileInput({ message, args, rawArgsText, refMsg });

      if (!parsed.text) {
        const helpText = `📜 **Format Aesthetic Quote (${prefix}quote / ${prefix}q)**:\n` +
          `• **Custom Penuh:** \`${prefix}quote Nama Tokoh | @username | Kata mutiara\`\n` +
          `• **Custom Foto:** Lampirkan foto lalu ketik \`${prefix}quote Tokoh | @username | Kutipan\`\n` +
          `• **Mention Teman:** \`${prefix}quote @user Kata mutiara konyol\`\n` +
          `• **Reply Pesan:** Reply chat teman lalu ketik \`${prefix}quote\`\n` +
          `• **Quote Sendiri:** \`${prefix}quote Hidup ini indah\``;
        await message.reply({ content: helpText });
        replyTextOutput = helpText;
        return replyTextOutput;
      }

      try {
        const now = new Date();
        const quoteBuf = await makeAestheticQuote({
          name: parsed.name,
          username: parsed.username,
          text: parsed.text,
          avatarBuffer: parsed.avatarBuffer,
          year: String(now.getFullYear())
        });

        const attachment = new AttachmentBuilder(quoteBuf, { name: 'quote.png' });
        await message.reply({ files: [attachment] });
        replyTextOutput = '[Aesthetic Quote Terkirim]';
      } catch (err) {
        console.error('[QUOTE] Error:', err);
        await message.reply({ content: `❌ Gagal membuat quote: ${err.message}` });
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

    // --- SOUNDBOARD VOICE CHANNEL ---
    // --- SOUNDBOARD VOICE CHANNEL ---
    case 'addsound':
    case 'soundboard':
    case 'sb':
    case 'convertsb':
    case 'tomp3sb': {
      if (!message.guild) {
        await message.reply({ content: '❌ Perintah soundboard hanya bisa digunakan di dalam server Discord.' });
        break;
      }

      const sub = (args[0] || '').toLowerCase();
      if (sub === 'list') {
        return await handleCommand({ message, command: 'listsound', args: args.slice(1), rawText });
      }
      if (sub === 'play') {
        return await handleCommand({ message, command: 'playsound', args: args.slice(1), rawText });
      }
      if (sub === 'del' || sub === 'delete' || sub === 'remove') {
        return await handleCommand({ message, command: 'delsound', args: args.slice(1), rawText });
      }

      let soundName = '';
      let startSec = 0;
      let argSlice = sub === 'add' ? args.slice(1) : args;

      if (argSlice.length > 0) {
        soundName = argSlice[0].trim();
        if (argSlice[1] && !isNaN(parseFloat(argSlice[1]))) {
          startSec = parseFloat(argSlice[1]);
        }
      }

      const media = await getMediaBuffer(message, argSlice.slice(1));
      if (!media || !media.buffer) {
        const helpEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🎙️ Convert MP3 ke Soundboard Voice Channel')
          .setDescription([
            'Fitur ini mengonversi file audio atau video menjadi Soundboard resmi Discord agar bisa langsung diputar di Voice Channel!',
            '',
            '📌 **Cara Penggunaan:**',
            `1. **Lampirkan MP3/Audio/Video** dan beri caption:`,
            `   \`${prefix}addsound <nama_sound> [detik_mulai]\``,
            `2. **Atau reply** pesan yang berisi audio/MP3 dengan:`,
            `   \`${prefix}addsound <nama_sound>\``,
            `3. **Atau gunakan link audio langsung:**`,
            `   \`${prefix}addsound <nama_sound> <link_mp3>\``,
            '',
            '💡 **Contoh:**',
            `• \`${prefix}addsound ketawa\` (potong 5.2 detik dari awal)`,
            `• \`${prefix}addsound meme 8\` (potong 5.2 detik mulai detik ke-8)`,
            `• \`${prefix}playsound ketawa\` (putar di Voice Channel)`,
            `• \`${prefix}listsound\` (lihat daftar soundboard server)`
          ].join('\n'))
          .setFooter({ text: 'Maksimal durasi: 5 detik (standar Discord Soundboard)' });
        await message.reply({ embeds: [helpEmbed] });
        break;
      }

      if (!soundName && media.name) {
        soundName = path.parse(media.name).name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
      }
      if (!soundName || soundName.length < 2) {
        soundName = `sound_${Date.now().toString().slice(-4)}`;
      }

      const waitMsg = await message.reply({ content: `⏳ Mengonversi audio **${soundName}** menjadi format Soundboard Discord...` });

      try {
        const botToken = client.token || process.env.DISCORD_TOKEN;
        const created = await soundboardManager.createSoundboardSound(botToken, message.guild.id, {
          name: soundName,
          audioBuffer: media.buffer,
          startSec: startSec,
          emojiName: '🔊'
        });

        const successEmbed = new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('✅ Soundboard Berhasil Dibuat & Siap Diputar!')
          .setDescription([
            `Suara **${created.name}** resmi terdaftar di Soundboard server!`,
            '',
            `🎵 **Nama Sound:** \`${created.name}\``,
            `⏱️ **Durasi:** Maks 5 detik`,
            `🔊 **Emoji:** ${created.emoji_name || '🔊'}`,
            `🆔 **Sound ID:** \`${created.sound_id}\``,
            '',
            '🎮 **Cara Memutar di Voice Channel:**',
            `1. Masuk ke Voice Channel (misal: Voice Lobby).`,
            `2. Ketik perintah: \`${prefix}playsound ${created.name}\``,
            `3. Atau klik langsung icon **Soundboard** di panel Voice Channel Discord kamu!`
          ].join('\n'))
          .setFooter({ text: `Dibuat oleh ${message.author.displayName || message.author.username}` })
          .setTimestamp();

        await waitMsg.edit({ content: null, embeds: [successEmbed] });
        replyTextOutput = `[Soundboard ${created.name} berhasil dibuat]`;
      } catch (err) {
        console.error('Error create soundboard:', err);
        await waitMsg.edit({ content: `❌ Gagal membuat soundboard: ${err.message}` });
      }
      break;
    }

    // --- CUSTOM AUDIO STREAMING / VOICE CHANNEL ---
    case 'play':
    case 'playsound':
    case 'sbplay':
    case 'playvc':
    case 'putarsound': {
      if (!voicePlayer) {
        await message.reply({ content: '⚠️ Streaming audio panjang memerlukan Node.js 22.12 atau lebih baru. Pilih runtime Node 22 di panel hosting, lalu restart bot.' });
        break;
      }
      if (!message.guild) {
        await message.reply({ content: '❌ Perintah pemutar audio hanya bisa digunakan di dalam server Discord.' });
        break;
      }

      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        const text = '⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const query = args[0] || '';
      const secondArg = args[1];
      const thirdArg = args[2];
      let sound = query ? voicePlayer.getCustomSound(query) : null;
      if (!sound && query && isNaN(parseFloat(query)) && !message.attachments?.size && !message.reference) {
        try {
          const botToken = client.token || process.env.DISCORD_TOKEN;
          const nativeSounds = await soundboardManager.listSoundboardSounds(botToken, message.guild.id);
          const nativeTarget = nativeSounds.find(s => s.sound_id === query || s.name.toLowerCase() === query.toLowerCase());
          if (nativeTarget) {
            await soundboardManager.playSoundboardInVoice(botToken, voiceChannel.id, nativeTarget.sound_id);
            await message.reply({ content: `🔊 Memutar Soundboard resmi **${nativeTarget.name}** di <#${voiceChannel.id}>.` });
            break;
          }
        } catch (err) {
          console.error('Native Soundboard lookup failed:', err.message);
        }
      }
      let media = null;
      let durationSec = null;
      let startSec = 0;

      if (sound) {
        durationSec = secondArg && !isNaN(parseFloat(secondArg)) ? parseFloat(secondArg) : null;
        startSec = thirdArg && !isNaN(parseFloat(thirdArg)) ? parseFloat(thirdArg) : 0;
      } else {
        media = await getMediaBuffer(message, args);
        if (!media || !media.buffer) {
          const text = `⚠️ Audio tidak ditemukan. Upload atau reply file audio, atau gunakan \`${prefix}listsounds\` untuk melihat library.`;
          await message.reply({ content: text });
          break;
        }
        durationSec = query && !isNaN(parseFloat(query)) ? parseFloat(query) : null;
        startSec = secondArg && !isNaN(parseFloat(secondArg)) ? parseFloat(secondArg) : 0;
      }

      if (durationSec && (durationSec < 1 || durationSec > 600)) {
        await message.reply({ content: '❌ Durasi harus antara 1 dan 600 detik (10 menit).' });
        break;
      }

      const waitMsg = await message.reply({ content: `⏳ Menghubungkan ke <#${voiceChannel.id}> dan menyiapkan audio...` });
      try {
        const audioSource = sound ? sound.filePath : media.buffer;
        await voicePlayer.playAudioInVoice({
          voiceChannel,
          audioSource,
          options: { startSec, durationSec }
        });
        const displayName = sound ? `**${sound.name}**` : (media.name || 'audio');
        await waitMsg.edit({ content: `🔊 Memutar ${displayName} di <#${voiceChannel.id}>${durationSec ? ` selama **${voicePlayer.formatTime(durationSec)}**` : ''}. Bot akan keluar setelah 2 menit idle.` });
        replyTextOutput = `[Memutar ${displayName} di voice channel]`;
      } catch (err) {
        console.error('Error play VC audio:', err);
        await waitMsg.edit({ content: `❌ Gagal memutar audio: ${err.message}` });
      }
      break;
    }

    case 'savesound':
    case 'savesb':
    case 'simpan_audio': {
      if (!message.guild) {
        await message.reply({ content: '❌ Perintah hanya bisa digunakan di server Discord.' });
        break;
      }
      const name = args[0];
      const durationSec = args[1] && !isNaN(parseFloat(args[1])) ? parseFloat(args[1]) : null;
      const startSec = args[2] && !isNaN(parseFloat(args[2])) ? parseFloat(args[2]) : 0;
      if (!name || name.length < 2) {
        await message.reply({ content: `Format: \`${prefix}savesound <nama> [durasi_detik] [detik_mulai]\`` });
        break;
      }
      if (durationSec && (durationSec < 1 || durationSec > 600)) {
        await message.reply({ content: '❌ Durasi harus antara 1 dan 600 detik (10 menit).' });
        break;
      }
      const media = await getMediaBuffer(message, args.slice(3));
      if (!media || !media.buffer) {
        await message.reply({ content: '❌ Lampirkan atau reply file audio untuk disimpan.' });
        break;
      }
      const waitMsg = await message.reply({ content: `⏳ Menyimpan **${name}**...` });
      try {
        const saved = voicePlayer.saveCustomSound({ name, audioBuffer: media.buffer, startSec, durationSec });
        await waitMsg.edit({ content: `✅ **${saved.name}** tersimpan (${saved.durationText}, ${saved.sizeKb} KB). Putar dengan \`${prefix}play ${saved.name}\`.` });
        replyTextOutput = `[Audio ${saved.name} disimpan]`;
      } catch (err) {
        await waitMsg.edit({ content: `❌ Gagal menyimpan audio: ${err.message}` });
      }
      break;
    }

    case 'listsounds':
    case 'listcustomsounds': {
      const sounds = voicePlayer.listCustomSounds();
      if (!sounds.length) {
        await message.reply({ content: `📂 Library audio kustom kosong. Reply atau lampirkan audio dengan \`${prefix}savesound <nama> [durasi]\`.` });
        break;
      }
      const lines = sounds.map((s, idx) => `**${idx + 1}.** \`${s.name}\` — ${s.durationText} (${s.sizeKb} KB)`);
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎵 Library Audio Kustom')
        .setDescription(lines.join('\\n').slice(0, 4000))
        .setFooter({ text: `Gunakan ${prefix}play <nama> • Maksimum 10 menit` });
      await message.reply({ embeds: [embed] });
      break;
    }

    case 'stopvc':
    case 'leavevc':
    case 'stopaudio': {
      if (!message.guild) {
        await message.reply({ content: '❌ Perintah hanya bisa digunakan di server Discord.' });
        break;
      }
      const stopped = voicePlayer.stopAudio(message.guild.id);
      const left = voicePlayer.leaveVoice(message.guild.id);
      const text = stopped || left ? '⏹️ Audio dihentikan dan bot keluar dari Voice Channel.' : 'ℹ️ Bot tidak sedang memutar audio atau berada di Voice Channel.';
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'listsound':
    case 'soundlist':
    case 'sblist': {
      if (!message.guild) {
        await message.reply({ content: '❌ Perintah soundboard hanya bisa digunakan di dalam server Discord.' });
        break;
      }
      try {
        const botToken = client.token || process.env.DISCORD_TOKEN;
        const sounds = await soundboardManager.listSoundboardSounds(botToken, message.guild.id);
        if (!sounds || sounds.length === 0) {
          await message.reply({ content: `📂 Belum ada Soundboard resmi Discord di server ini. Gunakan \`${prefix}listsounds\` untuk library audio panjang.` });
          break;
        }
        const lines = sounds.map((s, idx) => `**${idx + 1}.** ${s.emoji_name || '🔊'} **${s.name}** — \`${prefix}playsound ${s.name}\``);
        const embed = new EmbedBuilder().setColor('#5865F2').setTitle(`🎙️ Soundboard Resmi Server (${sounds.length})`).setDescription(lines.join('\\n').slice(0, 4000));
        await message.reply({ embeds: [embed] });
      } catch (err) {
        await message.reply({ content: `❌ Gagal mengambil daftar Soundboard: ${err.message}` });
      }
      break;
    }

    case 'delsound':
    case 'sbdel':
    case 'hapussound': {
      if (!message.guild) {
        await message.reply({ content: '❌ Perintah soundboard hanya bisa digunakan di dalam server Discord.' });
        break;
      }
      const isOwner = message.author.id === config.ownerId || message.author.id === process.env.OWNER_ID;
      const isAdmin = message.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
        message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild);
      if (!isOwner && !isAdmin) {
        await message.reply({ content: '❌ Hanya owner atau admin server yang bisa menghapus Soundboard resmi.' });
        break;
      }
      const query = args.join(' ').toLowerCase().trim();
      if (!query) {
        await message.reply({ content: `⚠️ Masukkan nama soundboard: \`${prefix}delsound <nama>\`` });
        break;
      }
      try {
        const botToken = client.token || process.env.DISCORD_TOKEN;
        const sounds = await soundboardManager.listSoundboardSounds(botToken, message.guild.id);
        const target = sounds.find(s => s.sound_id === query || s.name.toLowerCase() === query);
        if (!target) {
          await message.reply({ content: `❌ Soundboard **"${query}"** tidak ditemukan di server ini.` });
          break;
        }
        await soundboardManager.deleteSoundboardSound(botToken, message.guild.id, target.sound_id);
        await message.reply({ content: `🗑️ Soundboard resmi **${target.name}** berhasil dihapus.` });
      } catch (err) {
        await message.reply({ content: `❌ Gagal menghapus Soundboard: ${err.message}` });
      }
      break;
    }


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

    // --- EKONOMI ---
case 'bal':
    case 'balance':
    case 'dompet':
    case 'saldo': {
      const target = message.mentions.users.first() || message.author;
      const account = economyManager.getUser(target.id);
      const total = account.wallet + account.bank;
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle(`💰 Profil Ekonomi: ${target.displayName || target.username}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '👑 Gelar', value: account.title || '*Belum memiliki gelar (cek `' + prefix + 'shop`)*', inline: false },
          { name: '💵 Dompet', value: economyManager.formatCoin(account.wallet), inline: true },
          { name: '🏦 Bank', value: economyManager.formatCoin(account.bank), inline: true },
          { name: '💎 Total', value: economyManager.formatCoin(total), inline: true },
          { name: '🔥 Daily Streak', value: `${account.dailyStreak || 0} hari berturut-turut`, inline: true }
        );

      const activeBuffs = [];
      if (account.buffs?.shieldActive) activeBuffs.push('🛡️ Perisai Anti-Rampok Aktif (1x Tahan Rampok)');
      if (account.buffs?.luckyCharges > 0) activeBuffs.push(`🍀 Jimat Hoki Aktif (${account.buffs.luckyCharges}x kemenangan taruhan)`);
      if (account.buffs?.workDoubler > 0) activeBuffs.push(`🧪 Elixir Kerja Aktif (${account.buffs.workDoubler}x gaji ganda .work)`);
      if (account.buffs?.hasSafe) activeBuffs.push('🔐 Brankas Rahasia Aktif (60% koin dompet terlindungi)');

      if (activeBuffs.length > 0) {
        embed.addFields({ name: '✨ Efek & Perlindungan Aktif', value: activeBuffs.join('\n'), inline: false });
      }

      embed.setFooter({ text: `Ketik ${prefix}shop untuk belanja item | ${prefix}inv untuk cek tas | ${prefix}jual untuk cairkan hasil panen` }).setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Total saldo ${target.username}: ${economyManager.formatCoin(total)}`;
      break;
    }

case 'daily':
    case 'harian': {
      const result = economyManager.claimDaily(userId);
      let text = '';
      if (result.success) {
        text = `🎁 Kamu mendapat **+${economyManager.formatCoin(result.totalReward)}**! (Hadiah Dasar: ${economyManager.formatCoin(result.baseReward)}${result.streakBonus > 0 ? ` + Bonus Streak: +${economyManager.formatCoin(result.streakBonus)}` : ''})\n🔥 Daily Streak: **${result.streak} hari berturut-turut**!`;
        if (result.gotFreeBox) {
          text += `\n🎉 **MILESTONE STREAK 7 HARI!** Kamu dihadiahi bonus **1x 🎁 Mystery Box** gratis di tasmu!`;
        }
        text += `\n💵 Saldo dompet: **${economyManager.formatCoin(result.newWallet)}**.`;
      } else {
        text = `⏳ Daily sudah diklaim. Coba lagi dalam **${economyManager.formatTime(result.remainingMs)}**.`;
      }
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'work':
    case 'kerja': {
      const result = economyManager.workJob(userId);
      let text = '';
      if (result.success) {
        const bonusTag = result.doubled ? ` 🧪 **[ELIXIR 2X GAJI!]** (Sisa Elixir: ${result.remainingCharges}x)` : '';
        text = `💼 **${result.job}**${bonusTag}\n${result.desc}.\nGaji didapat: **+${economyManager.formatCoin(result.salary)}**.\nSaldo dompet: **${economyManager.formatCoin(result.newWallet)}**.`;
      } else {
        text = `☕ Istirahat dulu. Bisa kerja lagi dalam **${economyManager.formatTime(result.remainingMs)}**.`;
      }
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'dep':
    case 'deposit':
    case 'wd':
    case 'withdraw':
    case 'tarik': {
      const isDeposit = ['dep', 'deposit'].includes(command);
      const result = isDeposit
        ? economyManager.deposit(userId, (args[0] || '').toLowerCase())
        : economyManager.withdraw(userId, (args[0] || '').toLowerCase());
      const text = result.success
        ? `${isDeposit ? '🏦 Deposit' : '🏧 Penarikan'} berhasil: **${economyManager.formatCoin(isDeposit ? result.deposited : result.withdrawn)}**.\nDompet: **${economyManager.formatCoin(result.wallet)}** | Bank: **${economyManager.formatCoin(result.bank)}**.`
        : `❌ ${result.error || `Gunakan ${prefix}${isDeposit ? 'dep' : 'wd'} <jumlah/all>.`}`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'pay':
    case 'transfer':
    case 'tf': {
      const target = message.mentions.users.first();
      const amount = args.find(a => /^\d+$/.test(a));
      if (!target || !amount || target.bot) {
        const text = `Format: \`${prefix}pay @user <jumlah>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const result = economyManager.transfer(userId, target.id, amount);
      const text = result.success
        ? `💸 Terkirim **${economyManager.formatCoin(result.amount)}** ke **${target.displayName || target.username}**. Saldo dompetmu: **${economyManager.formatCoin(result.fromWallet)}**.`
        : `❌ ${result.error}`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    // --- PERINTAH OWNER: MANAJEMEN KOIN & OWNER ---
    case 'addcoin':
    case 'givecoin':
    case 'tambahkoin':
    case 'kasihkoin':
    case 'addmoney': {
      if (!isBotOwner(message)) {
        const text = '⛔ **Akses Ditolak!** Perintah ini khusus untuk **Owner Bot**.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      let targetUser = null;
      let amount = NaN;
      let destination = 'wallet';

      const destIndex = args.findIndex(a => ['bank', 'dompet', 'wallet'].includes(a.toLowerCase()));
      if (destIndex !== -1) {
        destination = args[destIndex].toLowerCase() === 'bank' ? 'bank' : 'wallet';
      }
      const filteredArgs = args.filter((_, idx) => idx !== destIndex);

      if (message.mentions && message.mentions.users.size > 0) {
        targetUser = message.mentions.users.first();
        for (const arg of filteredArgs) {
          if (arg.startsWith('<@') && arg.endsWith('>')) continue;
          const parsed = parseCoinAmount(arg);
          if (!isNaN(parsed) && parsed > 0) {
            amount = parsed;
            break;
          }
        }
      } else {
        if (filteredArgs.length === 1) {
          const parsed = parseCoinAmount(filteredArgs[0]);
          if (!isNaN(parsed) && parsed > 0) {
            targetUser = message.author;
            amount = parsed;
          }
        } else if (filteredArgs.length >= 2) {
          const first = filteredArgs[0].toLowerCase();
          if (['me', 'self', 'diri', 'saya'].includes(first)) {
            targetUser = message.author;
            amount = parseCoinAmount(filteredArgs[1]);
          } else if (/^\d{16,21}$/.test(filteredArgs[0])) {
            try {
              targetUser = await client.users.fetch(filteredArgs[0]).catch(() => null);
            } catch (_) {}
            if (!targetUser) {
              targetUser = { id: filteredArgs[0], username: `User-${filteredArgs[0]}`, displayName: `User (${filteredArgs[0]})` };
            }
            amount = parseCoinAmount(filteredArgs[1]);
          } else {
            const parsed = parseCoinAmount(filteredArgs[0]);
            if (!isNaN(parsed) && parsed > 0) {
              targetUser = message.author;
              amount = parsed;
            }
          }
        }
      }

      if (!targetUser || isNaN(amount) || amount <= 0) {
        const text = `👑 **Perintah Owner: Tambah Koin**\n` +
          `• \`${prefix}addcoin <jumlah>\` — Tambah koin ke diri sendiri\n` +
          `• \`${prefix}addcoin @user <jumlah>\` — Tambah koin ke orang lain\n` +
          `• \`${prefix}addcoin <userID> <jumlah>\` — Tambah koin via Discord User ID\n` +
          `• \`${prefix}addcoin @user <jumlah> bank\` — Masukkan langsung ke bank\n\n` +
          `*Contoh:* \`${prefix}addcoin 1000000\` atau \`${prefix}addcoin @Rex 500k bank\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      let updated;
      if (destination === 'bank') {
        updated = economyManager.addBank(targetUser.id, amount);
      } else {
        updated = economyManager.addWallet(targetUser.id, amount);
      }

      const isSelf = targetUser.id === message.author.id;
      const targetLabel = isSelf ? `dirimu sendiri (<@${targetUser.id}>)` : `**${targetUser.displayName || targetUser.username}** (<@${targetUser.id}>)`;
      const destLabel = destination === 'bank' ? 'Rekening Bank 🏦' : 'Dompet 💵';

      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('💸 [Owner Command] Koin Berhasil Ditambahkan!')
        .setDescription(`Berhasil memberikan **+${economyManager.formatCoin(amount)}** ke ${targetLabel} (${destLabel}).`)
        .addFields(
          { name: '💵 Dompet', value: economyManager.formatCoin(updated.wallet), inline: true },
          { name: '🏦 Bank', value: economyManager.formatCoin(updated.bank), inline: true },
          { name: '💎 Total Saldo', value: economyManager.formatCoin(updated.wallet + updated.bank), inline: true }
        )
        .setFooter({ text: `Diberikan oleh Owner: ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Owner berhasil menambahkan ${amount} koin ke ${targetUser.id}`;
      break;
    }

    case 'delcoin':
    case 'removecoin':
    case 'kurangkoin':
    case 'tarikkoin': {
      if (!isBotOwner(message)) {
        const text = '⛔ **Akses Ditolak!** Perintah ini khusus untuk **Owner Bot**.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      let targetUser = null;
      let amount = NaN;
      let destination = 'wallet';

      const destIndex = args.findIndex(a => ['bank', 'dompet', 'wallet'].includes(a.toLowerCase()));
      if (destIndex !== -1) {
        destination = args[destIndex].toLowerCase() === 'bank' ? 'bank' : 'wallet';
      }
      const filteredArgs = args.filter((_, idx) => idx !== destIndex);

      if (message.mentions && message.mentions.users.size > 0) {
        targetUser = message.mentions.users.first();
        for (const arg of filteredArgs) {
          if (arg.startsWith('<@') && arg.endsWith('>')) continue;
          const parsed = parseCoinAmount(arg);
          if (!isNaN(parsed) && parsed > 0) {
            amount = parsed;
            break;
          }
        }
      } else {
        if (filteredArgs.length === 1) {
          const parsed = parseCoinAmount(filteredArgs[0]);
          if (!isNaN(parsed) && parsed > 0) {
            targetUser = message.author;
            amount = parsed;
          }
        } else if (filteredArgs.length >= 2) {
          const first = filteredArgs[0].toLowerCase();
          if (['me', 'self', 'diri', 'saya'].includes(first)) {
            targetUser = message.author;
            amount = parseCoinAmount(filteredArgs[1]);
          } else if (/^\d{16,21}$/.test(filteredArgs[0])) {
            try {
              targetUser = await client.users.fetch(filteredArgs[0]).catch(() => null);
            } catch (_) {}
            if (!targetUser) {
              targetUser = { id: filteredArgs[0], username: `User-${filteredArgs[0]}`, displayName: `User (${filteredArgs[0]})` };
            }
            amount = parseCoinAmount(filteredArgs[1]);
          }
        }
      }

      if (!targetUser || isNaN(amount) || amount <= 0) {
        const text = `Format: \`${prefix}delcoin [@user / me / userID] <jumlah> [bank]\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      let updated;
      if (destination === 'bank') {
        updated = economyManager.removeBank(targetUser.id, amount);
      } else {
        updated = economyManager.removeWallet(targetUser.id, amount);
      }

      const isSelf = targetUser.id === message.author.id;
      const targetLabel = isSelf ? `dirimu sendiri (<@${targetUser.id}>)` : `**${targetUser.displayName || targetUser.username}** (<@${targetUser.id}>)`;
      const destLabel = destination === 'bank' ? 'Rekening Bank 🏦' : 'Dompet 💵';

      const text = `✂️ **[Owner] Saldo Dikurangi!** Berhasil menarik **-${economyManager.formatCoin(amount)}** dari ${targetLabel} (${destLabel}).\nSisa Dompet: **${economyManager.formatCoin(updated.wallet)}** | Bank: **${economyManager.formatCoin(updated.bank)}**.`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'setcoin':
    case 'setmoney': {
      if (!isBotOwner(message)) {
        const text = '⛔ **Akses Ditolak!** Perintah ini khusus untuk **Owner Bot**.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      let targetUser = null;
      let amount = NaN;
      let destination = 'wallet';

      const destIndex = args.findIndex(a => ['bank', 'dompet', 'wallet'].includes(a.toLowerCase()));
      if (destIndex !== -1) {
        destination = args[destIndex].toLowerCase() === 'bank' ? 'bank' : 'wallet';
      }
      const filteredArgs = args.filter((_, idx) => idx !== destIndex);

      if (message.mentions && message.mentions.users.size > 0) {
        targetUser = message.mentions.users.first();
        for (const arg of filteredArgs) {
          if (arg.startsWith('<@') && arg.endsWith('>')) continue;
          const parsed = parseCoinAmount(arg);
          if (!isNaN(parsed) && parsed >= 0) {
            amount = parsed;
            break;
          }
        }
      } else {
        if (filteredArgs.length === 1) {
          const parsed = parseCoinAmount(filteredArgs[0]);
          if (!isNaN(parsed) && parsed >= 0) {
            targetUser = message.author;
            amount = parsed;
          }
        } else if (filteredArgs.length >= 2) {
          const first = filteredArgs[0].toLowerCase();
          if (['me', 'self', 'diri', 'saya'].includes(first)) {
            targetUser = message.author;
            amount = parseCoinAmount(filteredArgs[1]);
          } else if (/^\d{16,21}$/.test(filteredArgs[0])) {
            try {
              targetUser = await client.users.fetch(filteredArgs[0]).catch(() => null);
            } catch (_) {}
            if (!targetUser) {
              targetUser = { id: filteredArgs[0], username: `User-${filteredArgs[0]}`, displayName: `User (${filteredArgs[0]})` };
            }
            amount = parseCoinAmount(filteredArgs[1]);
          }
        }
      }

      if (!targetUser || isNaN(amount) || amount < 0) {
        const text = `Format: \`${prefix}setcoin [@user / me / userID] <jumlah> [bank]\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      let updated;
      if (destination === 'bank') {
        updated = economyManager.setBank(targetUser.id, amount);
      } else {
        updated = economyManager.setWallet(targetUser.id, amount);
      }

      const isSelf = targetUser.id === message.author.id;
      const targetLabel = isSelf ? `dirimu sendiri (<@${targetUser.id}>)` : `**${targetUser.displayName || targetUser.username}** (<@${targetUser.id}>)`;
      const destLabel = destination === 'bank' ? 'Rekening Bank 🏦' : 'Dompet 💵';

      const text = `🔧 **[Owner] Saldo Diatur!** Saldo ${destLabel} untuk ${targetLabel} telah disetel menjadi **${economyManager.formatCoin(amount)}**.\nDompet: **${economyManager.formatCoin(updated.wallet)}** | Bank: **${economyManager.formatCoin(updated.bank)}**.`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'addowner': {
      if (!isBotOwner(message)) {
        const text = '⛔ **Akses Ditolak!** Hanya owner bot yang bisa menambahkan owner baru.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      let targetUser = message.mentions.users.first();
      if (!targetUser && args[0] && /^\d{16,21}$/.test(args[0])) {
        try {
          targetUser = await client.users.fetch(args[0]).catch(() => null);
        } catch (_) {}
      }
      if (!targetUser) {
        const text = `Format: \`${prefix}addowner @user\` atau \`${prefix}addowner <userID>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const list = getCustomOwners();
      if (!list.includes(targetUser.id)) {
        list.push(targetUser.id);
        saveCustomOwners(list);
      }
      const text = `✅ <@${targetUser.id}> berhasil didaftarkan sebagai **Owner Bot** resmi!`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'delowner': {
      if (!isBotOwner(message)) {
        const text = '⛔ **Akses Ditolak!** Hanya owner bot yang bisa mencopot owner.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      let targetUser = message.mentions.users.first();
      if (!targetUser && args[0] && /^\d{16,21}$/.test(args[0])) {
        try {
          targetUser = await client.users.fetch(args[0]).catch(() => null);
        } catch (_) {}
      }
      if (!targetUser) {
        const text = `Format: \`${prefix}delowner @user\` atau \`${prefix}delowner <userID>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      let list = getCustomOwners();
      list = list.filter(id => id !== targetUser.id);
      saveCustomOwners(list);
      const text = `✅ <@${targetUser.id}> telah dicopot dari daftar owner bot.`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'rob':
    case 'rampok': {
      const target = message.mentions.users.first();
      if (!target || target.bot) {
        const text = `Format: \`${prefix}rob @user\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const result = economyManager.robUser(userId, target.id);
      let text;
      if (result.onCooldown) text = `🚨 Tunggu **${economyManager.formatTime(result.remainingMs)}** sebelum mencoba lagi.`;
      else if (result.caught) text = `🚔 Gagal dan tertangkap! Denda **${economyManager.formatCoin(result.fine)}** dibayarkan ke korban.`;
      else if (result.success) text = `🦹 Berhasil mengambil **${economyManager.formatCoin(result.stolen)}** dari dompet target!`;
      else text = `❌ ${result.error}`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    // --- FITUR EKONOMI BARU: CRIME, BEG, MANCING, MINING, JUAL, SETTITLE, LOTRE, GIFT, PRANK ---
    case 'crime':
    case 'begal':
    case 'kriminal': {
      const result = economyManager.crimeJob(userId);
      let text = '';
      if (result.onCooldown) {
        text = `🚨 Polisi sedang patroli ketat! Tunggu **${economyManager.formatTime(result.remainingMs)}** sebelum beraksi lagi.`;
      } else if (result.success) {
        text = `🦹 **AKSI KEJAHATAN BERHASIL!**\nMisi: *${result.action}*\nHasil jarahan koin: **+${economyManager.formatCoin(result.loot)}**!\n💵 Saldo dompetmu: **${economyManager.formatCoin(result.newWallet)}**.`;
      } else {
        text = `🚔 **TERCYDUK POLISI!**\n*${result.failDesc}*\nKamu kena denda tilang: **-${economyManager.formatCoin(result.fine)}**!\n💵 Sisa saldo dompet: **${economyManager.formatCoin(result.newWallet)}**.`;
      }
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'beg':
    case 'minta':
    case 'ngemis': {
      const result = economyManager.begCoin(userId);
      let text = '';
      if (result.onCooldown) {
        text = `⏳ Jangan terlalu sering minta-minta! Tunggu **${economyManager.formatTime(result.remainingMs)}**.`;
      } else if (result.success) {
        text = `🥺 *${result.text}*\nKamu diberi sedekah: **+${economyManager.formatCoin(result.coin)}**!\n💵 Saldo dompet: **${economyManager.formatCoin(result.newWallet)}**.`;
      } else {
        text = `🥺 *${result.text}*\nKamu tidak mendapatkan apa-apa kali ini.`;
      }
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'mancing':
    case 'fish':
    case 'mancingikan': {
      const result = economyManager.fishAction(userId);
      if (result.onCooldown) {
        const text = `🎣 Ikan sedang tidak nafsu makan. Bisa mancing lagi dalam **${economyManager.formatTime(result.remainingMs)}**.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const c = result.catch;
      const baitNotice = result.hasBait ? '\n🪱 *Kamu menggunakan 1x Umpan Cacing Sakti (Peluang tangkapan langka berlipat!)*' : '';
      const embed = new EmbedBuilder()
        .setColor(0x00A8FC)
        .setTitle(`🎣 Mancing Mania: ${authorName}`)
        .setDescription(`Kailmu ditarik kuat ke dasar dan kamu mendapatkan:\n\n${c.emoji} **${c.name}**\n💰 Nilai Jual: **${economyManager.formatCoin(c.value)}**\n📦 Total di tas: **${result.newCount}x**${baitNotice}`)
        .setFooter({ text: `Ketik ${prefix}jual untuk menjual hasil tangkapan menjadi koin | ${prefix}inv untuk cek tas` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Mancing dapat ${c.name}`;
      break;
    }

    case 'mining':
    case 'tambang':
    case 'nambang': {
      const result = economyManager.mineAction(userId);
      if (result.onCooldown) {
        const text = `⛏️ Lorong tambang masih berbahaya. Bisa menambang lagi dalam **${economyManager.formatTime(result.remainingMs)}**.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const ore = result.ore;
      const pickNotice = result.hasPickaxe ? '\n⛏️ *Menggunakan Beliung Tambang Besi (Bonus mineral berharga!)*' : '';
      const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle(`⛏️ Ekskavasi Tambang: ${authorName}`)
        .setDescription(`Kamu mengayunkan beliung ke bebatuan gua dan menambang:\n\n${ore.emoji} **${result.amount}x ${ore.name}**\n💰 Nilai per bijih: **${economyManager.formatCoin(ore.value)}**\n📦 Total di tas: **${result.newCount}x**${pickNotice}`)
        .setFooter({ text: `Ketik ${prefix}jual untuk mencairkan hasil tambang jadi koin | ${prefix}inv untuk cek tas` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Mining dapat ${ore.name}`;
      break;
    }

    case 'sell':
    case 'jual': {
      const query = (args[0] || '').toLowerCase();
      const result = economyManager.sellItems(userId, query);
      if (!result.success) {
        await message.reply({ content: `❌ ${result.error}` });
        replyTextOutput = result.error;
        break;
      }

      const lines = result.soldRecords.map(r => `• ${r.emoji} **${r.count}x ${r.name}** ➔ **+${economyManager.formatCoin(r.gain)}**`);
      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`🏪 Penjualan Hasil Panen: ${authorName}`)
        .setDescription(`Berhasil menjual komoditas ke pasar koin:\n\n${lines.join('\n')}\n\n💰 **Total Koin Diterima:** +**${economyManager.formatCoin(result.totalGain)}**\n💵 **Saldo Dompet Sekarang:** **${economyManager.formatCoin(result.newWallet)}**`)
        .setFooter({ text: `Dapatkan lebih banyak koin lewat ${prefix}mancing dan ${prefix}mining!` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Jual barang dapat +${result.totalGain} koin`;
      break;
    }

    case 'settitle':
    case 'gelar': {
      const titleInput = args.join(' ');
      if (!titleInput) {
        const text = `Format: \`${prefix}settitle <nama gelar kamu>\`\n*(Membutuhkan item Tiket Gelar Kustom dari \`${prefix}shop\`)*`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const result = economyManager.setCustomTitle(userId, titleInput);
      if (!result.success) {
        await message.reply({ content: `❌ ${result.error}` });
        replyTextOutput = result.error;
        break;
      }

      let text = `🎉 **Gelar Baru Terpasang!** Profilmu kini menyandang gelar: **${result.title}**!\nCek profil barumu dengan \`${prefix}bal\`.`;
      if (message.guild && message.member) {
        const roleSync = await syncDiscordTitleRole(message.guild, message.member, result.title, 0xEB459E);
        if (roleSync.success) {
          text += `\n✨ **Role Discord Otomatis Terpasang:** Role **${result.title}** telah dibuatkan & disematkan ke akunmu!`;
        } else {
          text += `\nℹ️ *Catatan Role Discord:* ${roleSync.reason}`;
        }
        const nicknameSync = await syncDiscordTitleNickname(message.guild, message.member, result.title);
        if (nicknameSync.success) {
          text += `\n🏷️ Nickname server kini **${nicknameSync.nickname}**.`;
        } else {
          text += `\nℹ️ *Catatan nickname:* ${nicknameSync.reason}`;
        }
      }
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'syncgelar':
    case 'pasangrole': {
      if (!message.guild || !message.member) {
        const text = '⚠️ Perintah ini hanya bisa digunakan di dalam server Discord!';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const account = economyManager.getUser(userId);
      if (!account.title) {
        const text = `⚠️ Kamu belum memiliki gelar aktif! Beli gelar di \`${prefix}shop\` atau pasang dengan \`${prefix}settitle <nama gelar>\`.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const titleColors = {
        '👑 Sultan Server': 0xFEE75C,
        '🎲 Raja Judi': 0x57F287,
        '🔥 Lord Tuff': 0xED4245,
        '💎 Konglomerat Server': 0x5865F2
      };
      const color = titleColors[account.title] || 0xEB459E;
      const roleSync = await syncDiscordTitleRole(message.guild, message.member, account.title, color);
      const nicknameSync = await syncDiscordTitleNickname(message.guild, message.member, account.title);
      if (roleSync.success) {
        const text = `🎉 **Role Gelar Berhasil Disinkronkan!** Role **${account.title}** telah dipasangkan ke akunmu dan tampil terpisah di daftar member!`;
        await message.reply({ content: text });
        replyTextOutput = text;
      } else {
        const text = `❌ **Gagal Memasang Role:** ${roleSync.reason}`;
        await message.reply({ content: text });
        replyTextOutput = text;
      }
      const nicknameText = nicknameSync.success
        ? `🏷️ Nickname server sekarang **${nicknameSync.nickname}**.`
        : `ℹ️ Nickname belum berubah: ${nicknameSync.reason}`;
      await message.channel.send(nicknameText);
      replyTextOutput += `\n${nicknameText}`;
      break;
    }

    case 'copotgelar':
    case 'cleartitle':
    case 'removetitle': {
      const account = economyManager.getUser(userId);
      if (!account.title) {
        const text = '⚠️ Kamu sedang tidak memakai gelar apa pun.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const oldTitle = account.title;
      economyManager.setUserTitle(userId, null);
      if (message.guild && message.member) {
        await removeDiscordTitleRole(message.guild, message.member, oldTitle);
        await resetDiscordTitleNickname(message.guild, message.member);
      }
      const text = `✅ Gelar **${oldTitle}** telah dicopot dari profilmu, role dilepas, dan nickname server dikembalikan.`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'lotre':
    case 'lottery': {
      const info = economyManager.getLotteryInfo();
      const myTickets = info.tickets[userId] || 0;
      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🎟️ Jackpot Lotre Koin Mingguan Server')
        .setDescription(`Kumpulkan tiket lotre dan menangkan jackpot koin raksasa!\n\n💰 **Total Jackpot Pool Saat Ini:** **${economyManager.formatCoin(info.pool)}**\n🎟️ **Harga Tiket:** 500 🪙 (80% masuk ke jackpot pool)\n👥 **Total Tiket Terjual:** ${info.totalTickets} tiket\n🎫 **Tiket Milikmu:** **${myTickets} tiket**\n\nCara beli tiket: Ketik \`${prefix}buy tiket_lotre\``)
        .setFooter({ text: 'Semakin banyak tiket yang kamu miliki, semakin besar peluang menang jackpot!' })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = 'Info lotre ditampilkan';
      break;
    }

    case 'gift':
    case 'kado': {
      const target = message.mentions.users.first();
      const rawAmt = args.find(a => /^\d+$/.test(a));
      if (!target || !rawAmt || target.bot || target.id === userId) {
        const text = `Format: \`${prefix}gift @user <jumlah_koin> [pesan ucapan]\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const note = args.filter(a => !a.startsWith('<@') && a !== rawAmt).join(' ') || 'Semoga harimu menyenangkan!';
      const result = economyManager.transfer(userId, target.id, rawAmt);
      if (!result.success) {
        await message.reply({ content: `❌ ${result.error}` });
        replyTextOutput = result.error;
        break;
      }

      const embed = new EmbedBuilder()
        .setColor(0xE91E63)
        .setTitle('🎀 Paket Kado Kejutan Terkirim!')
        .setDescription(`Dari: **${authorName}**\nUntuk: <@${target.id}>\n\n🎁 **Isi Kado:** **${economyManager.formatCoin(result.amount)}**\n💌 **Ucapan:** *"${note}"*\n\nSisa saldo dompetmu: **${economyManager.formatCoin(result.fromWallet)}**`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Gift terkirim ke ${target.username}`;
      break;
    }

    case 'prank':
    case 'bom': {
      const target = message.mentions.users.first();
      if (!target || target.id === userId) {
        const text = `Format: \`${prefix}prank @user\` *(Memerlukan item Bom Tepung Jahil dari \`${prefix}shop\`)*`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const userAcc = economyManager.getUser(userId);
      if (!userAcc.inventory || !userAcc.inventory.bom_jahil || userAcc.inventory.bom_jahil <= 0) {
        const text = `❌ Kamu tidak memiliki **💣 Bom Tepung Jahil** di tas! Beli di \`${prefix}shop\` seharga 1.000 🪙.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      economyManager.useItem(userId, 'bom_jahil');

      const text = `💣💥 **DUAAARRRR!!**\n**${authorName}** melempar bom tepung jahil ke muka <@${target.id}>!\nSeluruh tubuh <@${target.id}> langsung putih belepotan tepung dan batuk-batuk! 🤣💨`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }


    case 'rich':
    case 'lb':
    case 'leaderboard':
    case 'topkoin': {
      const entries = economyManager.getLeaderboard(10);
      const lines = entries.map((entry, i) => {
        const titleBadge = entry.title ? ` [${entry.title}]` : '';
        return `${['🥇','🥈','🥉'][i] || `**${i + 1}.**`} <@${entry.userId}>${titleBadge} — **${economyManager.formatCoin(entry.total)}**`;
      });
      const text = lines.length ? `🏆 **Top Member Terkaya**\n${lines.join('\n')}` : 'Belum ada data ekonomi.';
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'shop':
    case 'toko': {
      const catalog = economyManager.getShopCatalog();
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🏪 Toko Item In-Game (Penukaran Koin)')
        .setDescription(`Tukarkan koin hasil kerja & game kamu dengan item, buff, dan gelar eksklusif!\n\nCara beli: \`${prefix}buy <id_item>\`\nContoh: \`${prefix}buy shield\` atau \`${prefix}buy kopi\``)
        .setTimestamp();

      catalog.forEach(item => {
        embed.addFields({
          name: `${item.emoji} ${item.name} — \`${item.id}\``,
          value: `💰 **Harga:** ${economyManager.formatCoin(item.price)}\n📝 ${item.desc}`,
          inline: false
        });
      });

      embed.setFooter({ text: `Ketik ${prefix}inv untuk cek tas kamu | ${prefix}bal untuk cek saldo dompet` });

      await message.reply({ embeds: [embed] });
      replyTextOutput = 'Katalog toko berhasil ditampilkan.';
      break;
    }

    case 'buy':
    case 'beli': {
      const itemId = (args[0] || '').toLowerCase();
      if (!itemId) {
        const text = `⚠️ Sebutkan ID item yang ingin kamu beli! Contoh: \`${prefix}buy shield\`\nKetik \`${prefix}shop\` untuk melihat katalog lengkap item.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const result = economyManager.buyItem(userId, itemId);
      if (!result.success) {
        await message.reply({ content: `❌ ${result.error}` });
        replyTextOutput = result.error;
        break;
      }

      const item = result.item;
      let text = `🎉 **Pembelian Berhasil!** Kamu membeli **${item.emoji} ${item.name}** seharga **${economyManager.formatCoin(item.price)}**.\nSisa saldo dompetmu: **${economyManager.formatCoin(result.newWallet)}**.`;
      if (result.titleEquipped) {
        text += `\n👑 Gelar **${result.titleEquipped}** langsung terpasang di profilmu!`;
        if (message.guild && message.member) {
          const titleColors = {
            '👑 Sultan Server': 0xFEE75C,
            '🎲 Raja Judi': 0x57F287,
            '🔥 Lord Tuff': 0xED4245,
            '💎 Konglomerat Server': 0x5865F2
          };
          const color = titleColors[result.titleEquipped] || 0xFEE75C;
          const roleSync = await syncDiscordTitleRole(message.guild, message.member, result.titleEquipped, color);
          if (roleSync.success) {
            text += `\n✨ **Role Discord Otomatis Terpasang:** Role **${result.titleEquipped}** telah diberikan kepadamu & tampil terpisah di daftar member!`;
          } else {
            text += `\nℹ️ *Catatan Role Discord:* ${roleSync.reason}`;
          }
          const nicknameSync = await syncDiscordTitleNickname(message.guild, message.member, result.titleEquipped);
          if (nicknameSync.success) {
            text += `\n🏷️ Nickname server kini **${nicknameSync.nickname}**.`;
          } else {
            text += `\nℹ️ *Catatan nickname:* ${nicknameSync.reason}`;
          }
        }
      } else if (item.id === 'shield') {
        text += `\n🛡️ Perisai Anti-Rampok otomatis aktif melindungi dompetmu!`;
      } else if (item.id === 'jimat') {
        text += `\n🍀 Jimat Hoki otomatis aktif untuk 3x kemenangan taruhan berikutnya!`;
      } else {
        text += `\n📦 Item tersimpan di tasmu. Ketik \`${prefix}use ${item.id}\` untuk menggunakannya!`;
      }

      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'inv':
    case 'inventory':
    case 'tas': {
      const target = message.mentions.users.first() || message.author;
      const account = economyManager.getUser(target.id);
      const inv = account.inventory || {};
      const catalog = economyManager.getShopCatalog();

      const itemsList = [];
      for (const [id, count] of Object.entries(inv)) {
        if (count > 0) {
          const item = catalog.find(i => i.id === id);
          itemsList.push(`${item ? item.emoji : '📦'} **${item ? item.name : id}** (\`${id}\`): **${count}x**`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🎒 Tas & Inventaris: ${target.displayName || target.username}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '👑 Gelar Aktif', value: account.title || '*Tidak ada*', inline: true },
          { name: '🛡️ Perisai', value: account.buffs?.shieldActive ? 'Aktif' : 'Tidak aktif', inline: true },
          { name: '🍀 Jimat Hoki', value: account.buffs?.luckyCharges > 0 ? `${account.buffs.luckyCharges}x kemenangan` : 'Tidak aktif', inline: true },
          { name: '📦 Daftar Barang', value: itemsList.length > 0 ? itemsList.join('\n') : '*Tas masih kosong! Beli item di `' + prefix + 'shop`*', inline: false }
        )
        .setFooter({ text: `Gunakan item dengan ${prefix}use <id_item>` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = 'Inventaris berhasil ditampilkan.';
      break;
    }

    case 'use':
    case 'pakai': {
      const itemId = (args[0] || '').toLowerCase();
      if (!itemId) {
        const text = `⚠️ Sebutkan ID item yang ingin kamu pakai! Contoh: \`${prefix}use kopi\` atau \`${prefix}use box\`\nKetik \`${prefix}inv\` untuk cek tas kamu.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const result = economyManager.useItem(userId, itemId);
      if (!result.success) {
        await message.reply({ content: `❌ ${result.error}` });
        replyTextOutput = result.error;
        break;
      }
      await message.reply({ content: result.message });
      replyTextOutput = result.message;
      break;
    }

    // --- MINI GAMES ---
    case 'slot':
    case 'slots':
    case 'jackpot': {
      const account = economyManager.getUser(userId);
      const betArg = (args[0] || '').toLowerCase();
      const bet = ['all', 'semua'].includes(betArg) ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Taruhan harus angka positif dan tidak melebihi saldo dompet (${economyManager.formatCoin(account.wallet)}). Format: \`${prefix}slot <jumlah/all>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      economyManager.removeWallet(userId, bet);
      const game = gamesManager.playSlot(bet);
      let luckyBonus = 0;
      let luckyMsg = '';
      if (game.won) {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          luckyBonus = Math.floor(game.payout * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(luckyBonus)} (Sisa: ${luckyStatus.remaining}x)`;
        }
      }
      if (game.payout + luckyBonus > 0) economyManager.addWallet(userId, game.payout + luckyBonus);
      const after = economyManager.getUser(userId);
      const text = `🎰 **${game.reels.join(' | ')}**\n${game.title}\nTaruhan: ${economyManager.formatCoin(bet)} | Hasil bersih: **${game.netProfit >= 0 ? '+' : '-'}${economyManager.formatCoin(Math.abs(game.netProfit))}**\nDompet: ${economyManager.formatCoin(after.wallet)}`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'dadu':
    case 'dice': {
      const betArg = (args[0] || '').toLowerCase();
      if (!betArg) {
        const roll = Math.floor(Math.random() * 6) + 1;
        const text = `🎲 ${authorName} melempar dadu: **${roll}**.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const account = economyManager.getUser(userId);
      const bet = betArg === 'all' ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Taruhan tidak valid. Saldo dompet: ${economyManager.formatCoin(account.wallet)}.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      economyManager.removeWallet(userId, bet);
      const game = gamesManager.playDice(bet);
      let luckyBonus = 0;
      let luckyMsg = '';
      if (game.result === 'win') {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          luckyBonus = Math.floor(bet * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(luckyBonus)} (Sisa: ${luckyStatus.remaining}x)`;
        }
      }
      if (game.payout + luckyBonus > 0) economyManager.addWallet(userId, game.payout + luckyBonus);
      const after = economyManager.getUser(userId);
      const text = `🎲 Kamu **${game.playerRoll}** vs bot **${game.botRoll}**${luckyMsg}.\n${game.desc}\nSaldo dompet: **${economyManager.formatCoin(after.wallet)}**.`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'koin':
    case 'coinflip':
    case 'cf': {
      const rawArg1 = (args[0] || '').toLowerCase();
      const rawArg2 = (args[1] || '').toLowerCase();

      let sideArg = '';
      let betArg = '';

      const validSideKeywords = [
        'gambar', 'g', 'heads', 'head', 'h',
        'angka', 'a', 'tails', 'tail', 't',
        'benar', 'bener', 'b', 'true',
        'salah', 's', 'false'
      ];

      if (validSideKeywords.includes(rawArg1)) {
        sideArg = rawArg1;
        betArg = rawArg2;
      } else if (validSideKeywords.includes(rawArg2)) {
        sideArg = rawArg2;
        betArg = rawArg1;
      } else if (rawArg1) {
        sideArg = rawArg1;
        betArg = rawArg2;
      }

      // Jika tanpa pilihan sama sekali -> Lempar koin kasual
      if (!sideArg) {
        const randomRoll = Math.random() < 0.5 ? 'GAMBAR' : 'ANGKA';
        const text = `🪙 Koin dilempar ke udara dan mendarat pada: **${randomRoll}**!\n\nUntuk bermain tebakan:\n• Kasual (Gratis): \`${prefix}cf <gambar/angka/benar/salah>\`\n• Taruhan koin: \`${prefix}cf <gambar/angka/benar/salah> <jumlah/all>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      // Jika ada pilihan tapi tanpa taruhan -> Coinflip kasual (bisa BENAR atau SALAH)
      if (!betArg) {
        const game = gamesManager.playCoinflip(sideArg, 0);
        const resultBanner = game.won
          ? '🎉 **TEBAKAN KAMU BENAR!** Koin mendarat tepat sesuai pilihanmu!'
          : '💀 **TEBAKAN KAMU SALAH!** Koin mendarat di sisi sebaliknya.';

        const text = `🪙 **Coinflip Kasual**\nPilihanmu: **${game.choice.toUpperCase()}**\nHasil Lemparan: **${game.roll.toUpperCase()}**\n\n${resultBanner}\n*(Main bertaruh: \`${prefix}cf ${game.choice} 100\`)*`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      // Jika bermain taruhan koin
      const account = economyManager.getUser(userId);
      const bet = ['all', 'semua'].includes(betArg) ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Taruhan tidak valid! Pastikan berupa angka positif dan tidak melebihi saldo dompetmu (${economyManager.formatCoin(account.wallet)}).\nFormat: \`${prefix}cf <pilihan> <jumlah/all>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      economyManager.removeWallet(userId, bet);
      const game = gamesManager.playCoinflip(sideArg, bet);

      // Cek efek Jimat Hoki jika menang
      let extraLuckyBonus = 0;
      let luckyMsg = '';
      if (game.won) {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          extraLuckyBonus = Math.floor(bet * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(extraLuckyBonus)} (Sisa jimat: ${luckyStatus.remaining}x)`;
        }
      }

      const totalPayout = game.won ? (game.payout + extraLuckyBonus) : 0;
      if (totalPayout > 0) {
        economyManager.addWallet(userId, totalPayout);
      }

      const after = economyManager.getUser(userId);
      const profit = game.won ? (bet + extraLuckyBonus) : bet;

      const verdict = game.won
        ? `🎉 **TEBAKAN BENAR (MENANG)!** Kamu mendapatkan **+${economyManager.formatCoin(profit)}**!${luckyMsg}`
        : `💀 **TEBAKAN SALAH (KALAH)!** Kamu kehilangan **-${economyManager.formatCoin(bet)}**!`;

      const text = `🪙 **Coinflip Bertaruh**\nPilihanmu: **${game.choice.toUpperCase()}** | Hasil Lemparan: **${game.roll.toUpperCase()}**\n\n${verdict}\n💵 Dompet Sekarang: **${economyManager.formatCoin(after.wallet)}**`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'tebakangka':
    case 'guessnum': {
      const guess = Number.parseInt(args[0], 10);
      const betArg = (args[1] || '').toLowerCase();
      const account = economyManager.getUser(userId);
      const bet = betArg === 'all' ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isInteger(guess) || guess < 1 || guess > 10 || !Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Format: \`${prefix}tebakangka <1-10> <jumlah/all>\`. Saldo dompet: ${economyManager.formatCoin(account.wallet)}.`;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      economyManager.removeWallet(userId, bet);
      const secret = Math.floor(Math.random() * 10) + 1;
      const won = guess === secret;
      if (won) economyManager.addWallet(userId, bet * 5);
      const after = economyManager.getUser(userId);
      const text = `🔢 Tebakanmu **${guess}**, angka rahasia **${secret}**. ${won ? `Tepat! Payout 5x, untung bersih +${economyManager.formatCoin(bet * 4)}.` : `Belum tepat, taruhan ${economyManager.formatCoin(bet)} hilang.`}\nDompet: ${economyManager.formatCoin(after.wallet)}.`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    // --- MINI GAMES BARU: ROULETTE, BLACKJACK, SUIT, HORSE RACE, MINES, MATH QUIZ ---
    case 'roulette':
    case 'rolet': {
      const choiceArg = (args[0] || '').toLowerCase();
      const betArg = (args[1] || '').toLowerCase();

      if (!choiceArg) {
        const text = `🎡 **CARA MAIN ROLET KASINO**\nFormat: \`${prefix}rolet <pilihan> <taruhan/all>\`\n\nPilihan yang tersedia:\n• \`merah\` / \`hitam\` (Payout 2x)\n• \`ganjil\` / \`genap\` (Payout 2x)\n• \`hijau\` (Angka 0, Payout 14x!)\n• Angka tunggal \`0\` s/d \`36\` (Payout 36x Mega Jackpot!)\n\nContoh: \`${prefix}rolet merah 500\` atau \`${prefix}rolet 7 200\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const account = economyManager.getUser(userId);
      const bet = ['all', 'semua'].includes(betArg) ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Taruhan tidak valid! Saldo dompetmu: ${economyManager.formatCoin(account.wallet)}. Format: \`${prefix}rolet <pilihan> <taruhan>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      economyManager.removeWallet(userId, bet);
      const game = gamesManager.playRoulette(choiceArg, bet);

      let luckyBonus = 0;
      let luckyMsg = '';
      if (game.won) {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          luckyBonus = Math.floor(game.payout * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(luckyBonus)} (Sisa: ${luckyStatus.remaining}x)`;
        }
      }

      const totalPayout = game.won ? (game.payout + luckyBonus) : 0;
      if (totalPayout > 0) economyManager.addWallet(userId, totalPayout);

      const after = economyManager.getUser(userId);
      const profitText = game.won ? `+${economyManager.formatCoin(game.payout - bet + luckyBonus)}` : `-${economyManager.formatCoin(bet)}`;

      const embed = new EmbedBuilder()
        .setColor(game.won ? 0x57F287 : 0xED4245)
        .setTitle('🎡 Meja Rolet Kasino Berputar...')
        .setDescription(`Bola mendarat pada: **${game.rollEmoji} Nomor ${game.rollNumber} (${game.rollColor.toUpperCase()})**!\n\nTaruhanmu: **${game.choiceDesc}** (${economyManager.formatCoin(bet)})\nHasil: ${game.won ? `🎉 **MENANG (${game.multiplier}x)!** Hasil bersih: **${profitText}**${luckyMsg}` : `💀 **KALAH!** Kehilangan ${economyManager.formatCoin(bet)}.`}\n\n💵 **Saldo Dompet:** **${economyManager.formatCoin(after.wallet)}**`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Rolet: ${game.won ? 'Menang' : 'Kalah'}`;
      break;
    }

    case 'bj':
    case 'blackjack': {
      const betArg = (args[0] || '').toLowerCase();
      const account = economyManager.getUser(userId);
      const bet = ['all', 'semua'].includes(betArg) ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Taruhan blackjack harus angka positif tidak melebihi dompet (${economyManager.formatCoin(account.wallet)}).\nFormat: \`${prefix}bj <taruhan/all>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      economyManager.removeWallet(userId, bet);
      const game = gamesManager.playBlackjack(bet);

      let luckyBonus = 0;
      let luckyMsg = '';
      if (game.result === 'win' || game.result === 'blackjack') {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          luckyBonus = Math.floor(game.payout * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(luckyBonus)} (Sisa: ${luckyStatus.remaining}x)`;
        }
      }

      const totalPayout = game.payout + luckyBonus;
      if (totalPayout > 0) economyManager.addWallet(userId, totalPayout);

      const after = economyManager.getUser(userId);
      const playerCardStrs = game.playerCards.map(c => `[${c.str}]`).join(' ');
      const dealerCardStrs = game.dealerCards.map(c => `[${c.str}]`).join(' ');

      const embed = new EmbedBuilder()
        .setColor(game.result === 'win' || game.result === 'blackjack' ? 0x57F287 : (game.result === 'draw' ? 0xFEE75C : 0xED4245))
        .setTitle('🃏 Meja Kartu Blackjack 21')
        .setDescription(`**${game.title}**\n\n👤 **Kartu Kamu:** ${playerCardStrs} (Total: **${game.playerTotal}**)\n🤖 **Kartu Dealer:** ${dealerCardStrs} (Total: **${game.dealerTotal}**)\n\n💰 **Taruhan:** ${economyManager.formatCoin(bet)}\n📊 **Hasil Bersih:** **${game.netProfit >= 0 ? '+' : ''}${economyManager.formatCoin(game.netProfit + luckyBonus)}**${luckyMsg}\n💵 **Saldo Dompet:** **${economyManager.formatCoin(after.wallet)}**`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Blackjack result: ${game.result}`;
      break;
    }

    case 'suit':
    case 'rps':
    case 'gbk': {
      const choiceArg = (args[0] || '').toLowerCase();
      const betArg = (args[1] || '').toLowerCase();

      if (!choiceArg) {
        const text = `✌️ **CARA MAIN SUIT JEPANG**\nFormat: \`${prefix}suit <batu/gunting/kertas> [taruhan/all]\`\n\nContoh:\n• Gratis: \`${prefix}suit batu\`\n• Taruhan: \`${prefix}suit batu 500\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const account = economyManager.getUser(userId);
      let bet = 0;
      if (betArg) {
        bet = ['all', 'semua'].includes(betArg) ? account.wallet : Number.parseInt(betArg, 10);
        if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
          const text = `Taruhan tidak valid! Saldo dompetmu: ${economyManager.formatCoin(account.wallet)}.`;
          await message.reply({ content: text });
          replyTextOutput = text;
          break;
        }
        economyManager.removeWallet(userId, bet);
      }

      const game = gamesManager.playRPS(choiceArg, bet);

      let luckyBonus = 0;
      let luckyMsg = '';
      if (game.result === 'win' && bet > 0) {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          luckyBonus = Math.floor(bet * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(luckyBonus)} (Sisa: ${luckyStatus.remaining}x)`;
        }
      }

      const totalPayout = game.payout + luckyBonus;
      if (totalPayout > 0) economyManager.addWallet(userId, totalPayout);

      const after = economyManager.getUser(userId);
      let verdict = '';
      if (game.result === 'win') {
        verdict = `🎉 **KAMU MENANG!** ${bet > 0 ? `Hadiah: **+${economyManager.formatCoin(bet + luckyBonus)}**` : ''}${luckyMsg}`;
      } else if (game.result === 'draw') {
        verdict = '🤝 **HASIL SERI!** Pilihan sama, taruhan dikembalikan.';
      } else {
        verdict = `💀 **KAMU KALAH!** ${bet > 0 ? `Kehilangan ${economyManager.formatCoin(bet)}.` : ''}`;
      }

      const text = `✌️ **Duel Suit (Gunting Batu Kertas)**\nKamu: **${game.playerPick.emoji} ${game.playerPick.name.toUpperCase()}** vs Bot: **${game.botPick.emoji} ${game.botPick.name.toUpperCase()}**\n\n${verdict}\n💵 Saldo Dompet: **${economyManager.formatCoin(after.wallet)}**`;
      await message.reply({ content: text });
      replyTextOutput = text;
      break;
    }

    case 'pacuankuda':
    case 'horse':
    case 'balap':
    case 'balapan': {
      const horseNo = Number(args[0]);
      const betArg = (args[1] || '').toLowerCase();

      if (!horseNo || horseNo < 1 || horseNo > 5) {
        const text = `🏇 **PACUAN KUDA SAMUDRA**\nPilih nomor kuda jagoanmu (1 s/d 5)!\n\n1. 🐎 Halilintar Cepat\n2. 🦄 Pegasus Emas\n3. 🐴 Kuda Hitam Perkasa\n4. 🦓 Zebra Kilat Samudra\n5. 🏇 Spirit Sang Juara\n\nFormat: \`${prefix}pacuankuda <1-5> <taruhan/all>\`\n*(Payout Menang: 4x Lipat!)*\nContoh: \`${prefix}pacuankuda 1 500\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const account = economyManager.getUser(userId);
      const bet = ['all', 'semua'].includes(betArg) ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Taruhan tidak valid! Saldo dompetmu: ${economyManager.formatCoin(account.wallet)}. Format: \`${prefix}pacuankuda <1-5> <taruhan>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      economyManager.removeWallet(userId, bet);
      const game = gamesManager.playHorseRace(horseNo, bet);

      let luckyBonus = 0;
      let luckyMsg = '';
      if (game.won) {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          luckyBonus = Math.floor(game.payout * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(luckyBonus)} (Sisa: ${luckyStatus.remaining}x)`;
        }
      }

      const totalPayout = game.payout + luckyBonus;
      if (totalPayout > 0) economyManager.addWallet(userId, totalPayout);

      const after = economyManager.getUser(userId);
      const embed = new EmbedBuilder()
        .setColor(game.won ? 0x57F287 : 0xED4245)
        .setTitle('🏇 Garis Akhir Balap Pacuan Kuda!')
        .setDescription(`**Lintasan Balap:**\n${game.tracksText}\n\nJagoanmu: **#${game.myHorse.no} ${game.myHorse.name}**\nPemenang Juara 1: **#${game.winningHorse.no} ${game.winningHorse.name}**\n\n${game.won ? `🎉 **KUDA KAMU JUARA 1 (Payout 4x)!** Untung bersih: **+${economyManager.formatCoin(game.netProfit + luckyBonus)}**!${luckyMsg}` : `💀 **KUDA KAMU KALAH!** Kehilangan ${economyManager.formatCoin(bet)}.`}\n\n💵 Saldo Dompet: **${economyManager.formatCoin(after.wallet)}**`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Pacuan kuda selesai. Winner: ${game.winningHorse.name}`;
      break;
    }

    case 'mines':
    case 'ranjau': {
      const mineArg = Number(args[0]);
      const betArg = (args[1] || '').toLowerCase();

      if (!mineArg || mineArg < 1 || mineArg > 5) {
        const text = `💣 **CARA MAIN TEBAK PETAK RANJAU (MINES)**\nTantang petak 3x3 dan lewati ranjau untuk melipatgandakan koin!\n\nFormat: \`${prefix}mines <1-5_ranjau> <taruhan/all>\`\n\nTingkat kesulitan:\n• 1 Ranjau: Multiplier 1.4x (Sangat Aman)\n• 2 Ranjau: Multiplier 1.8x\n• 3 Ranjau: Multiplier 2.5x (Standar)\n• 4 Ranjau: Multiplier 3.8x\n• 5 Ranjau: Multiplier 5.5x (Ekstrem)\n\nContoh: \`${prefix}mines 3 500\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      const account = economyManager.getUser(userId);
      const bet = ['all', 'semua'].includes(betArg) ? account.wallet : Number.parseInt(betArg, 10);
      if (!Number.isSafeInteger(bet) || bet <= 0 || bet > account.wallet) {
        const text = `Taruhan tidak valid! Saldo dompetmu: ${economyManager.formatCoin(account.wallet)}. Format: \`${prefix}mines <1-5> <taruhan>\``;
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }

      economyManager.removeWallet(userId, bet);
      const game = gamesManager.playMines(bet, mineArg);

      let luckyBonus = 0;
      let luckyMsg = '';
      if (game.survived) {
        const luckyStatus = economyManager.checkAndConsumeLucky(userId);
        if (luckyStatus.hasLucky) {
          luckyBonus = Math.floor(game.payout * 0.25);
          luckyMsg = `\n🍀 **Bonus Jimat Hoki (+25%):** +${economyManager.formatCoin(luckyBonus)} (Sisa: ${luckyStatus.remaining}x)`;
        }
      }

      const totalPayout = game.payout + luckyBonus;
      if (totalPayout > 0) economyManager.addWallet(userId, totalPayout);

      const after = economyManager.getUser(userId);
      const embed = new EmbedBuilder()
        .setColor(game.survived ? 0x57F287 : 0xED4245)
        .setTitle('💣 Eksplorasi Petak Ranjau')
        .setDescription(`**Peta Ranjau Terbuka (3x3):**\n\`\`\`\n${game.gridDisplay}\n\`\`\`\nJumlah Ranjau: **${game.mineCount} Ranjau**\nMultiplier: **${game.multiplier}x**\n\n${game.survived ? `💎 **SELAMAT! KAMU MELEWATI RANJAU DENGAN AMAN!**\nHasil bersih: **+${economyManager.formatCoin(game.netProfit + luckyBonus)}**!${luckyMsg}` : `💥 **KABOOM! KAMU MENGINJAK RANJAU!**\nKehilangan taruhan ${economyManager.formatCoin(bet)}.`}\n\n💵 Saldo Dompet: **${economyManager.formatCoin(after.wallet)}**`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Mines selesai: ${game.survived ? 'Selamat' : 'Meledak'}`;
      break;
    }

    case 'math':
    case 'hitung':
    case 'matematika': {
      const channelId = message.channel.id;
      if (activeMathQuiz.has(channelId)) {
        await message.reply({ content: '⚠️ Masih ada kuis hitung cepat yang sedang berlangsung di channel ini!' });
        return;
      }

      const quiz = gamesManager.generateMathQuiz();
      const session = {
        jawaban: quiz.jawaban,
        reward: quiz.reward,
        timer: setTimeout(async () => {
          if (activeMathQuiz.has(channelId)) {
            await message.channel.send(`⏰ **Waktu Habis!** Jawaban yang benar adalah **${quiz.jawaban}**!`).catch(() => {});
            activeMathQuiz.delete(channelId);
          }
        }, 30000)
      };

      activeMathQuiz.set(channelId, session);

      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🧠 KUIS HITUNG CEPAT REBUTAN KOIN!')
        .setDescription(`Berapakah hasil dari:\n\n# **${quiz.soal} = ?**\n\n⏱️ Waktu: **30 detik**\n🎁 Hadiah tercepat: **+${economyManager.formatCoin(quiz.reward)}**\n*Ketik langsung angka jawabanmu di chat channel ini!*`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Kuis math dimulai: ${quiz.soal}`;
      break;
    }


    case 'susunkata': {
      const channelId = message.channel.id;
      if (activeSusunKata.has(channelId)) {
        const text = 'Masih ada game susun kata aktif di channel ini.';
        await message.reply({ content: text });
        replyTextOutput = text;
        break;
      }
      const game = gamesManager.getRandomSusunKata();
      const session = { jawaban: game.kata.toLowerCase(), reward: game.reward, timer: null };
      session.timer = setTimeout(async () => {
        if (activeSusunKata.get(channelId) === session) {
          activeSusunKata.delete(channelId);
          await message.channel.send(`⏰ Waktu habis. Jawabannya **${game.kata.toUpperCase()}**.`).catch(() => {});
        }
      }, 60000);
      activeSusunKata.set(channelId, session);
      const text = `🔤 **Susun kata!**\nHuruf: **${game.acak}**\nPetunjuk: ${game.hint}\nHadiah: **${economyManager.formatCoin(game.reward)}**\nWaktu 60 detik, ketik jawaban di channel.`;
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
        const mediaResult = await getInstagramMedia(url);
        const items = Array.isArray(mediaResult) ? mediaResult : (mediaResult && mediaResult.url ? [mediaResult] : []);
        if (items.length > 0) {
          // Download media (jika carousel, ambil hingga 5 media agar tidak melebihi kuota pesan)
          const maxDownload = Math.min(items.length, 5);
          const filesToSend = [];
          const oversizedUrls = [];

          for (let i = 0; i < maxDownload; i++) {
            const media = items[i];
            const downloadUrl = media.url;
            try {
              const res = await axios.get(downloadUrl, { 
                responseType: 'arraybuffer', 
                timeout: 45000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
              });
              const buf = Buffer.from(res.data);
              
              // Deteksi format file secara akurat dari buffer atau URL
              let ext = 'mp4';
              if (buf.length >= 8) {
                const subHeader = buf.subarray(4, 8).toString();
                if (subHeader === 'ftyp' || buf.subarray(0, 4).toString() === 'moov') {
                  ext = 'mp4';
                } else if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
                  ext = 'jpg';
                } else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
                  ext = 'png';
                } else if (media.type === 'video' || downloadUrl.includes('.mp4')) {
                  ext = 'mp4';
                } else {
                  ext = 'jpg';
                }
              }

              if (buf.length > 24 * 1024 * 1024) {
                oversizedUrls.push(downloadUrl);
              } else {
                filesToSend.push(new AttachmentBuilder(buf, { name: `instagram_${Date.now()}_${i + 1}.${ext}` }));
              }
            } catch (dlErr) {
              console.error(`Gagal download item Instagram #${i + 1}:`, dlErr.message);
            }
          }

          if (filesToSend.length > 0) {
            let contentText = `✅ **Instagram Downloader**`;
            if (items.length > 1) {
              contentText += ` (${filesToSend.length} media)`;
            }
            if (oversizedUrls.length > 0) {
              contentText += `\n⚠️ Beberapa media melebihi limit 25MB:\n${oversizedUrls.map(u => `🔗 [Download Langsung](${u})`).join('\n')}`;
            }
            await message.reply({
              content: contentText,
              files: filesToSend
            });
            replyTextOutput = 'Instagram media berhasil dikirim.';
          } else if (oversizedUrls.length > 0) {
            await message.reply({
              content: `✅ **Instagram Downloader**\nUkuran file melebihi batas upload Discord (25 MB). Silakan unduh langsung melalui link berikut:\n${oversizedUrls.map(u => `🔗 [Download Media](${u})`).join('\n')}`
            });
            replyTextOutput = 'Instagram media link dikirim.';
          } else {
            await message.reply({ content: '❌ Gagal mengunduh file media dari link Instagram tersebut.' });
          }
        } else {
          await message.reply({ content: '❌ Tidak dapat menemukan media dari link Instagram tersebut. Pastikan postingan/Reel berasal dari akun publik (bukan akun privat).' });
        }
      } catch (err) {
        let msg = err.message || 'Terjadi kesalahan';
        if (msg.toLowerCase().includes('private')) {
          msg = 'Postingan/Reel berasal dari akun privat. Bot hanya dapat mengunduh konten dari akun publik.';
        }
        await message.reply({ content: `❌ Gagal download Instagram: ${msg}` });
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
    case 'afk': {
      const reason = args.join(' ').trim() || 'AFK (Sedang tidak di tempat)';
      afkManager.setAfk(userId, reason);

      const afkEmbed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('💤 Status AFK Aktif')
        .setDescription(`**${authorName}** sekarang berstatus **AFK**.\n📝 **Alasan:** *${reason}*`)
        .setFooter({ text: 'Ketik pesan apa saja di server nanti untuk otomatis mencabut status AFK' })
        .setTimestamp();

      await message.reply({ embeds: [afkEmbed] });
      replyTextOutput = `Status AFK aktif: ${reason}`;
      return replyTextOutput;
    }

    case 'setmenfess':
    case 'setconfess': {
      if (!message.guild) {
        return await message.reply({ content: '❌ Perintah ini hanya dapat digunakan di dalam server Discord!' });
      }

      const isOwner = config.ownerNumber && userId === config.ownerNumber;
      const isAdmin = message.member && (message.member.permissions.has(PermissionsBitField.Flags.Administrator) || message.member.permissions.has(PermissionsBitField.Flags.ManageGuild));
      if (!isAdmin && !isOwner) {
        return await message.reply({ content: '❌ Kamu memerlukan izin `Administrator` atau `Manage Server` untuk mengatur channel menfess!' });
      }

      const targetChannel = message.mentions.channels.first() || (args[0] && message.guild.channels.cache.get(args[0])) || message.channel;
      menfessManager.setMenfessChannel(message.guild.id, targetChannel.id);

      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Channel Menfess Berhasil Dikonfigurasi!')
        .setDescription(`Mulai sekarang, seluruh pesan curhat/menfess anonim akan dikirimkan ke channel <#${targetChannel.id}>.\n\nMember bisa mengirim menfess dengan cara:\n• \`${prefix}menfess <pesan>\` di channel server (pesan pengirim otomatis terhapus)\n• Atau lewat **DM langsung ke bot** (\`${prefix}menfess <pesan>\`) agar 100% rahasia tanpa jejak!`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      replyTextOutput = `Channel menfess diatur ke ${targetChannel.name}`;
      return replyTextOutput;
    }

    case 'menfess':
    case 'confess': {
      let mediaUrl = null;
      if (message.attachments && message.attachments.size > 0) {
        const att = message.attachments.first();
        if (!att.contentType || att.contentType.startsWith('image/')) {
          mediaUrl = att.url;
        }
      }

      const isDirectDm = args[0] && args[0].toLowerCase() === 'dm';
      if (isDirectDm) {
        const targetUser = message.mentions.users.first() || (args[1] && /^\d{17,20}$/.test(args[1]) ? await client.users.fetch(args[1]).catch(() => null) : null);
        const textMsg = targetUser ? (message.mentions.users.first() ? args.slice(2).join(' ') : args.slice(2).join(' ')) : '';

        if (!targetUser || !textMsg) {
          const text = `💌 **Format Menfess Privat via DM User:**\n\`${prefix}menfess dm @user <pesan kamu>\``;
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

          if (mediaUrl) embed.setImage(mediaUrl);

          await targetUser.send({ embeds: [embed] });

          if (message.guild && message.deletable) {
            try { await message.delete(); } catch (_) {}
          }

          const confirmMsg = await message.channel.send({ content: `✅ Pesan rahasia berhasil dikirimkan ke **${targetUser.tag}**!` });
          setTimeout(() => confirmMsg.delete().catch(() => {}), 5000);
          replyTextOutput = 'Menfess terkirim.';
          return replyTextOutput;
        } catch (err) {
          await message.reply({ content: `❌ Gagal mengirim menfess ke user tersebut (mungkin DM ditutup): ${err.message}` });
          return;
        }
      }

      const textMsg = args.join(' ').trim();
      if (!textMsg && !mediaUrl) {
        const guideText = [
          '💌 **Format Pengiriman Menfess / Pesan Anonim:**',
          `• **Kirim ke Channel Server:** \`${prefix}menfess <pesan kamu>\` (pesan kamu otomatis terhapus)`,
          `• **Kirim via DM Bot:** Kirim pesan ke DM bot \`${prefix}menfess <pesan>\` (100% aman tanpa jejak)`,
          `• **Kirim ke DM Orang Tertentu:** \`${prefix}menfess dm @user <pesan>\``,
          `• **Atur Channel Menfess (Admin):** \`${prefix}setmenfess #channel\``
        ].join('\n');
        await message.reply({ content: guideText });
        return;
      }

      if (message.guild && message.deletable) {
        try { await message.delete(); } catch (_) {}
      }

      let targetChannel = null;
      if (message.guild) {
        const cfg = menfessManager.getMenfessConfig(message.guild.id);
        if (cfg && cfg.channelId) {
          targetChannel = message.guild.channels.cache.get(cfg.channelId) || await client.channels.fetch(cfg.channelId).catch(() => null);
        }
        if (!targetChannel) {
          targetChannel = message.channel;
        }
      }

      if (!targetChannel) {
        await message.channel.send({ content: '❌ Tidak dapat menemukan channel pengiriman menfess.' });
        return;
      }

      const count = menfessManager.incrementAndGetCount(message.guild ? message.guild.id : 'global');
      const embed = menfessManager.buildMenfessEmbed({ count, text: textMsg, mediaUrl });
      await targetChannel.send({ embeds: [embed] });

      if (message.guild && targetChannel.id !== message.channel.id) {
        const notif = await message.channel.send({ content: `✅ Menfess anonim berhasil diposting ke <#${targetChannel.id}>!` });
        setTimeout(() => notif.delete().catch(() => {}), 4000);
      }

      replyTextOutput = `Menfess #${count} berhasil dikirim.`;
      return replyTextOutput;
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
      const ecoUser = economyManager.getUser(user.id);
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`👤 Info Pengguna: ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: '🆔 User ID', value: user.id, inline: true },
          { name: '🤖 Bot?', value: user.bot ? 'Ya' : 'Bukan', inline: true },
          { name: '👑 Gelar Kehormatan', value: ecoUser.title ? `**${ecoUser.title}**` : '*Belum ada gelar*', inline: true },
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
      const prize = 350;
      economyManager.addWallet(message.author.id, prize);
      await message.reply({
        content: `🎉 **BENAR!** Selamat **${message.author.displayName || message.author.username}**, jawabannya memang **${session.jawaban.toUpperCase()}**!\n🎁 Hadiah: **+${economyManager.formatCoin(prize)}**`
      });
      return;
    }
  }

  // Kuis matematika cepat aktif dapat dijawab oleh siapa pun di channel
  if (activeMathQuiz.has(channelId)) {
    const session = activeMathQuiz.get(channelId);
    if (message.content.trim() === session.jawaban) {
      clearTimeout(session.timer);
      activeMathQuiz.delete(channelId);
      economyManager.addWallet(message.author.id, session.reward);
      await message.reply({
        content: `🎉 **BENAR & TEPAT!** Selamat **${message.author.displayName || message.author.username}**, jawaban hitung cepatmu **${session.jawaban}** benar!\n🎁 Hadiah koin: **+${economyManager.formatCoin(session.reward)}**`
      });
      return;
    }
  }

  // Tebakan susun kata aktif dapat dijawab oleh siapa pun di channel.
  if (activeSusunKata.has(channelId)) {
    const session = activeSusunKata.get(channelId);
    if (message.content.toLowerCase().trim() === session.jawaban) {
      clearTimeout(session.timer);
      activeSusunKata.delete(channelId);
      economyManager.addWallet(message.author.id, session.reward);
      await message.reply({
        content: `🎉 **Benar!** Jawabannya **${session.jawaban.toUpperCase()}**. Kamu mendapat **+${economyManager.formatCoin(session.reward)}**!`
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
client.once(Events.ClientReady, async () => {
  try {
    await client.application?.fetch();
  } catch (_) {}
  console.log('========================================');
  console.log(`✅ ${config.botName} Berhasil Terhubung & Aktif!`);
  console.log(`🤖 Logged in as: ${client.user.tag} (ID: ${client.user.id})`);
  console.log(`🌐 Server Terhubung: ${client.guilds.cache.size} server`);
  console.log('========================================');
  client.user.setActivity({
    name: `${config.prefix}menu | ${config.botName}`,
    type: ActivityType.Playing
  });

  try {
    const { startWebServer } = require('./src/web-server');
    startWebServer(client, handleCommand);
  } catch (err) {
    console.error('⚠️ Gagal menjalankan Web Server terpadu, beralih ke IPC bawaan:', err.message);
    startIpcServer();
  }
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
