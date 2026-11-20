const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const economyManager = require('./economy-manager');
const dungeonManager = require('./dungeon-manager');
let soundboardManager = null;
try { soundboardManager = require('./soundboard-manager'); } catch (_) {}
let voicePlayer = null;
try {
  if (Number(process.versions.node.split('.')[0]) >= 22) {
    voicePlayer = require('./voice-player');
  }
} catch (_) {}

const GUILD_ID = '1339540412217430016';
const WEB_DIR = path.join(__dirname, '..', 'web');

// Sesi login in-memory sederhana
const sessions = new Map();

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function getUserIdFromReq(req, query) {
  // 1. Dari query param ?user_id=
  if (query && query.user_id) return query.user_id;
  // 2. Dari header x-user-id
  if (req.headers['x-user-id']) return req.headers['x-user-id'];
  // 3. Dari cookie sesi
  const cookies = parseCookies(req);
  if (cookies.session_id && sessions.has(cookies.session_id)) {
    return sessions.get(cookies.session_id).userId;
  }
  return null;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, Authorization'
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File Not Found');
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function startWebServer(client, handleCommand) {
  const server = http.createServer(async (req, res) => {
    // Handle CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-user-id, Authorization'
      });
      return res.end();
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    // 1. IPC CONSOLE ENDPOINT (send.js)
    if (req.method === 'POST' && pathname === '/send') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { target, message: textToSend } = JSON.parse(body);
          if (!textToSend) return sendJson(res, 400, { success: false, error: 'Pesan kosong' });

          let targetChannel = null;
          if (target && target !== 'default' && target !== 'channel') {
            try { targetChannel = await client.channels.fetch(target); } catch (_) {}
          }
          if (!targetChannel) {
            for (const guild of client.guilds.cache.values()) {
              const ch = guild.channels.cache.find(c => c.isTextBased() && c.viewable);
              if (ch) { targetChannel = ch; break; }
            }
          }
          if (!targetChannel) {
            return sendJson(res, 404, { success: false, error: 'Tidak ada channel Discord yang dapat diakses.' });
          }

          const prefix = process.env.BOT_PREFIX || '.';
          if (textToSend.startsWith(prefix) && handleCommand) {
            const [cmdRaw, ...args] = textToSend.slice(prefix.length).trim().split(/\s+/);
            const command = (cmdRaw || '').toLowerCase();
            const mockMsg = {
              author: { id: 'console-owner', username: 'Console', displayName: 'Console Admin' },
              content: textToSend,
              createdTimestamp: Date.now(),
              channel: targetChannel,
              guild: targetChannel.guild,
              attachments: new Map(),
              reply: async (p) => targetChannel.send(p)
            };
            const replyText = await handleCommand({ message: mockMsg, command, args, rawText: textToSend });
            return sendJson(res, 200, {
              success: true,
              isCommand: true,
              command: `.${command}`,
              replyText: replyText || '',
              channelName: `#${targetChannel.name} (${targetChannel.guild?.name || 'DM'})`
            });
          } else {
            await targetChannel.send(textToSend);
            return sendJson(res, 200, {
              success: true,
              isCommand: false,
              channelName: `#${targetChannel.name} (${targetChannel.guild?.name || 'DM'})`
            });
          }
        } catch (err) {
          return sendJson(res, 500, { success: false, error: err.message });
        }
      });
      return;
    }

    // 2. API ENDPOINTS
    if (pathname.startsWith('/api/')) {
      // API: Guild & Voice Channels
      if (pathname === '/api/guild') {
        const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
        if (!guild) return sendJson(res, 200, { name: 'Discord Server', id: GUILD_ID, channels: [] });

        const channels = [];
        guild.channels.cache.forEach(c => {
          // ChannelType.GuildVoice is 2
          if (c.type === 2 || c.isVoiceBased?.()) {
            channels.push({ id: c.id, name: c.name, membersCount: c.members?.size || 0 });
          }
        });
        return sendJson(res, 200, {
          id: guild.id,
          name: guild.name,
          icon: guild.iconURL() || null,
          memberCount: guild.memberCount,
          channels
        });
      }

      // API: User Session & Profile
      if (pathname === '/api/me') {
        const userId = getUserIdFromReq(req, query);
        if (!userId) {
          return sendJson(res, 200, { authenticated: false });
        }

        let userObj = null;
        try {
          userObj = await client.users.fetch(userId);
        } catch (_) {}

        const eco = economyManager.getUser(userId);
        const dungeon = dungeonManager.getUserDungeon(userId);

        return sendJson(res, 200, {
          authenticated: true,
          userId,
          username: userObj ? (userObj.displayName || userObj.username) : `Member ${userId.slice(0, 5)}`,
          avatar: userObj ? userObj.displayAvatarURL({ extension: 'png' }) : 'https://cdn.discordapp.com/embed/avatars/0.png',
          economy: {
            wallet: eco.wallet || 0,
            bank: eco.bank || 0,
            streak: eco.streak || 0,
            title: eco.title || null,
            inventory: eco.inventory || {}
          },
          dungeon
        });
      }

      // API: Quick Login (bisa pilih user ID atau nama member)
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { userId } = JSON.parse(body);
            if (!userId) return sendJson(res, 400, { error: 'userId diperlukan' });
            const sessionId = 'sess_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
            sessions.set(sessionId, { userId, createdAt: Date.now() });

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
              'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ success: true, userId, sessionId }));
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        });
        return;
      }

      // API: Logout
      if (pathname === '/api/auth/logout') {
        const cookies = parseCookies(req);
        if (cookies.session_id) sessions.delete(cookies.session_id);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`,
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({ success: true }));
      }

      // API: List Soundboard & Custom Sounds
      if (pathname === '/api/sounds') {
        const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
        let nativeSounds = [];
        if (soundboardManager && guild) {
          try {
            const token = client.token || process.env.DISCORD_TOKEN;
            nativeSounds = await soundboardManager.listSoundboardSounds(token, guild.id);
          } catch (e) {
            console.error('List native soundboard failed:', e.message);
          }
        }

        let customSounds = [];
        if (voicePlayer) {
          try {
            customSounds = voicePlayer.listCustomSounds();
          } catch (e) {
            console.error('List custom sounds failed:', e.message);
          }
        }

        return sendJson(res, 200, {
          nativeSounds: nativeSounds.map(s => ({
            id: s.sound_id,
            name: s.name,
            emoji: s.emoji_name || '🔊',
            isNative: true
          })),
          customSounds: customSounds.map(s => ({
            id: s.name,
            name: s.name,
            duration: s.durationText,
            sizeKb: s.sizeKb,
            isNative: false
          }))
        });
      }

      // API: Play Sound into Voice Channel
      if (pathname === '/api/sounds/play' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { soundId, channelId, isNative } = JSON.parse(body);
            if (!channelId) return sendJson(res, 400, { error: 'Voice channel ID diperlukan.' });

            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isVoiceBased()) {
              return sendJson(res, 404, { error: 'Voice channel tidak ditemukan atau bukan kanal suara.' });
            }

            if (isNative && soundboardManager) {
              const token = client.token || process.env.DISCORD_TOKEN;
              await soundboardManager.playSoundboardInVoice(token, channelId, soundId);
              return sendJson(res, 200, { success: true, message: `Soundboard dimainkan di ${channel.name}` });
            } else if (voicePlayer) {
              const sound = voicePlayer.getCustomSound(soundId);
              if (!sound) return sendJson(res, 404, { error: 'Audio kustom tidak ditemukan.' });

              await voicePlayer.playAudioInVoice({
                guildId: channel.guild.id,
                channelId: channel.id,
                voiceAdapterCreator: channel.guild.voiceAdapterCreator,
                inputSource: sound.filePath,
                isRawPath: true
              });
              return sendJson(res, 200, { success: true, message: `Audio ${sound.name} diputar di ${channel.name}` });
            } else {
              return sendJson(res, 500, { error: 'Pemutar suara belum tersedia di server.' });
            }
          } catch (err) {
            return sendJson(res, 500, { error: err.message });
          }
        });
        return;
      }

      // API: Stop VC
      if (pathname === '/api/sounds/stop' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { guildId } = JSON.parse(body || '{}');
            const targetGuildId = guildId || GUILD_ID;
            if (voicePlayer) {
              voicePlayer.stopAudio(targetGuildId);
              voicePlayer.leaveVoice(targetGuildId);
            }
            return sendJson(res, 200, { success: true, message: 'Audio dihentikan dan bot keluar dari VC.' });
          } catch (err) {
            return sendJson(res, 500, { error: err.message });
          }
        });
        return;
      }

      // API: Shop Catalog
      if (pathname === '/api/shop') {
        return sendJson(res, 200, { items: economyManager.getShopCatalog() });
      }

      // API: Buy Item
      if (pathname === '/api/shop/buy' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const userId = getUserIdFromReq(req, query);
            if (!userId) return sendJson(res, 401, { error: 'Harap masuk terlebih dahulu.' });

            const { itemId } = JSON.parse(body);
            const result = economyManager.buyItem(userId, itemId);
            if (!result.success) return sendJson(res, 400, result);

            // Jika item adalah perlengkapan dungeon, auto equip
            if (['iron_sword', 'moon_armor', 'cave_fox'].includes(itemId)) {
              try { dungeonManager.equip(userId, itemId); } catch (_) {}
            }

            return sendJson(res, 200, {
              success: true,
              message: `Berhasil membeli ${result.item.name}!`,
              item: result.item,
              newWallet: result.newWallet
            });
          } catch (err) {
            return sendJson(res, 500, { error: err.message });
          }
        });
        return;
      }

      // API: Leaderboard
      if (pathname === '/api/leaderboard') {
        const top = economyManager.getLeaderboard(10);
        return sendJson(res, 200, { leaderboard: top });
      }

      // API: Dungeon RPG
      if (pathname === '/api/dungeon') {
        const userId = getUserIdFromReq(req, query);
        if (!userId) return sendJson(res, 401, { error: 'Harap masuk terlebih dahulu.' });
        const state = dungeonManager.getUserDungeon(userId);
        return sendJson(res, 200, state);
      }

      // API: Dungeon RPG Actions
      if (pathname === '/api/dungeon/action' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const userId = getUserIdFromReq(req, query);
            if (!userId) return sendJson(res, 401, { error: 'Harap masuk terlebih dahulu.' });

            const { action, itemId } = JSON.parse(body);
            let updatedState = null;

            if (action === 'explore') {
              updatedState = dungeonManager.explore(userId);
            } else if (action === 'attack') {
              updatedState = dungeonManager.attack(userId);
            } else if (action === 'heal') {
              updatedState = dungeonManager.heal(userId);
            } else if (action === 'retreat') {
              updatedState = dungeonManager.retreat(userId);
            } else if (action === 'equip') {
              updatedState = dungeonManager.equip(userId, itemId);
            } else {
              return sendJson(res, 400, { error: 'Aksi tidak dikenal.' });
            }

            return sendJson(res, 200, { success: true, state: updatedState });
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        });
        return;
      }

      return sendJson(res, 404, { error: 'API endpoint not found' });
    }

    // 3. STATIC WEB DASHBOARD SERVING
    let reqFile = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let safePath = path.join(WEB_DIR, reqFile);
    if (!safePath.startsWith(WEB_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.ico': 'image/x-icon'
      };
      return sendFile(res, safePath, mimeTypes[ext] || 'application/octet-stream');
    }

    // Fallback to index.html for SPA client-side routing
    const indexPath = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      return sendFile(res, indexPath, 'text/html; charset=utf-8');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Web dashboard index.html not found');
  });

  // Bot-Hosting.net menggunakan SERVER_PORT (atau PORT atau 3000) yang harus di-bind ke 0.0.0.0
  const webPort = parseInt(process.env.SERVER_PORT || process.env.PORT || 3000, 10);
  server.listen(webPort, '0.0.0.0', () => {
    console.log(`🌐 [Web Dashboard Aktif] Berjalan di port ${webPort} (0.0.0.0)`);
    console.log(`   Akses domain di Bot-Hosting.net (misal: https://<nama>.apps.bot-hosting.cloud)`);
  });

  // Jika webPort bukan 45678, buat listener lokal khusus port 45678 agar "send.js" tetap bekerja tanpa hambatan!
  if (webPort !== 45678) {
    try {
      const ipcServer = http.createServer((req, res) => {
        // Forward /send langsung ke server utama
        server.emit('request', req, res);
      });
      ipcServer.listen(45678, '127.0.0.1', () => {
        console.log(`💡 [Console IPC Aktif] Siap di 127.0.0.1:45678 untuk 'node send.js'`);
      });
      ipcServer.on('error', (err) => {
        console.warn('IPC 45678 fallback notice:', err.message);
      });
    } catch (_) {}
  }

  return server;
}

module.exports = {
  startWebServer
};
