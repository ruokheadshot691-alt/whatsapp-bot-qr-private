const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const unoManager = require('./uno-manager');
let economyManager = null;
try { economyManager = require('./economy-manager'); } catch (_) {}

const WEB_DIR = path.join(__dirname, '..', 'web');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('File Not Found');
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function startUnoServer(client, handleCommand) {
  const server = http.createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
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

    // 2. UNO API ENDPOINTS
    // SSE Realtime Event Stream
    if (pathname === '/api/uno/events') {
      const roomId = query.roomId;
      const userId = query.userId;
      if (!roomId || !userId) {
        return sendJson(res, 400, { error: 'roomId and userId required' });
      }

      const room = unoManager.getRoom(roomId);
      if (!room) {
        return sendJson(res, 404, { error: 'Room not found' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('\n');

      res.unoUserId = userId;
      room.subscribe(res);

      // Kirim initial state
      const state = room.getPublicState(userId);
      res.write(`data: ${JSON.stringify(state)}\n\n`);

      req.on('close', () => {
        room.unsubscribe(res);
      });
      return;
    }

    // Get State
    if (pathname === '/api/uno/state') {
      const roomId = query.roomId;
      const userId = query.userId;
      if (!roomId) return sendJson(res, 400, { error: 'roomId required' });
      const room = unoManager.getRoom(roomId);
      if (!room) return sendJson(res, 404, { error: 'Room not found' });

      return sendJson(res, 200, room.getPublicState(userId));
    }

    // Player Actions
    if (pathname === '/api/uno/action' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { roomId, userId, userName, userAvatar, action, cardId, chosenColor, targetId } = JSON.parse(body);
          if (!roomId || !userId) return sendJson(res, 400, { error: 'roomId dan userId diperlukan' });

          let room = unoManager.getRoom(roomId);

          if (action === 'create_or_join') {
            if (!room) {
              room = unoManager.getOrCreateRoom(roomId, userId, userName, userAvatar);
            } else {
              room.addPlayer(userId, userName, userAvatar);
            }
            return sendJson(res, 200, { success: true, state: room.getPublicState(userId) });
          }

          if (!room) return sendJson(res, 404, { error: 'Kamar UNO tidak ditemukan!' });

          let result = { success: false, error: 'Aksi tidak valid' };

          if (action === 'join') {
            result = room.addPlayer(userId, userName, userAvatar);
          } else if (action === 'leave') {
            result = room.removePlayer(userId);
          } else if (action === 'start') {
            result = room.startGame(userId);
          } else if (action === 'play') {
            result = room.playCard(userId, cardId, chosenColor);
            if (result.won && result.winner && economyManager) {
              try {
                economyManager.addWallet(result.winner.id, 5000);
              } catch (_) {}
            }
          } else if (action === 'draw') {
            result = room.drawCard(userId);
          } else if (action === 'pass') {
            result = room.passTurn(userId);
          } else if (action === 'uno') {
            result = room.sayUno(userId);
          } else if (action === 'catch') {
            result = room.catchUno(userId, targetId);
          }

          if (!result.success) {
            return sendJson(res, 400, result);
          }

          return sendJson(res, 200, {
            success: true,
            state: room.getPublicState(userId),
            result
          });
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      });
      return;
    }

    // 3. STATIC UNO WEB SERVING
    if (pathname === '/' || pathname === '/uno' || pathname === '/uno.html' || pathname === '/index.html') {
      const unoHtmlPath = path.join(WEB_DIR, 'uno.html');
      if (fs.existsSync(unoHtmlPath)) {
        return sendFile(res, unoHtmlPath, 'text/html; charset=utf-8');
      }
    }

    let reqFile = pathname.replace(/^\//, '');
    let safePath = path.join(WEB_DIR, reqFile);
    if (safePath.startsWith(WEB_DIR) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav'
      };
      return sendFile(res, safePath, mimeTypes[ext] || 'application/octet-stream');
    }

    // Default fallback to uno.html
    const defaultUno = path.join(WEB_DIR, 'uno.html');
    if (fs.existsSync(defaultUno)) {
      return sendFile(res, defaultUno, 'text/html; charset=utf-8');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('UNO Web Interface not found');
  });

  const webPort = parseInt(process.env.SERVER_PORT || process.env.PORT || 3000, 10);
  server.listen(webPort, '0.0.0.0', () => {
    console.log(`🎴 [UNO Multiplayer Web Aktif] Berjalan di port ${webPort} (0.0.0.0)`);
  });

  if (webPort !== 45678) {
    try {
      const ipcServer = http.createServer((req, res) => {
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
  startUnoServer
};
