module.exports = {
  // Prefix perintah bot
  prefix: '.',

  // Nomor owner (ganti dengan nomor WhatsApp kamu tanpa +, contoh: '6281234567890')
  ownerNumber: '6281234567890',

  // Nama bot & pembuat stiker (Exif metadata)
  botName: 'KerenBot',
  stickerPack: 'KerenBot Stickers',
  stickerAuthor: 'by Fatih',

  // Pengaturan Anti-Blokir / Human-Like Delay
  antiBan: {
    minTypingDelayMs: 800,
    maxTypingDelayMs: 2000,
    userCooldownMs: 3500,
    maxCommandsPerMinute: 15,
  }
};
