require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Coba baca file lokal data/token.json jika ada
let localToken = '';
try {
  const tokenFile = path.join(__dirname, 'data', 'token.json');
  if (fs.existsSync(tokenFile)) {
    const parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));
    localToken = parsed.token || '';
  }
} catch (_) {}

module.exports = {
  // Token Discord Bot: prioritas process.env.DISCORD_TOKEN -> .env -> data/token.json
  token: process.env.DISCORD_TOKEN || localToken || '',

  // Prefix perintah bot di Discord
  prefix: process.env.BOT_PREFIX || '.',

  // ID Pemilik bot (Discord User ID)
  ownerId: process.env.OWNER_ID || '',

  // Nama bot
  botName: 'TuffBot Discord',

  // Warna default Embed (Discord Blurple)
  embedColor: 0x5865F2,

  // Port HTTP IPC untuk pengiriman via console (node send.js)
  ipcPort: 45678
};
