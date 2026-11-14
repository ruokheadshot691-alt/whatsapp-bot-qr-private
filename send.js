#!/usr/bin/env node

/**
 * Script CLI pengirim pesan Discord langsung dari console / bash terminal.
 * Berkomunikasi dengan bot yang sedang aktif via local HTTP IPC (port 45678).
 *
 * Contoh penggunaan:
 *   send default .menu                     (Kirim menu ke channel utama server)
 *   send default .ping                     (Cek kecepatan respon bot)
 *   send default .ai siapa penemu internet? (Tanya AI & tampilkan jawaban di console)
 *   send 123456789012345678 Halo semua!   (Kirim pesan ke channel ID tertentu)
 *   node send.js default .ping
 */

const http = require('http');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('⚠️ Format penggunaan salah!');
  console.log('   send <channel_id/default> <pesan/command>');
  console.log('Contoh:');
  console.log('   send default .menu                       (Kirim menu ke channel pertama)');
  console.log('   send default .ping                       (Cek ping)');
  console.log('   send default .ai siapa penemu internet?  (Tanya AI & hasil keluar di console)');
  console.log('   send 123456789012345678 Halo semuanya!   (Kirim pesan ke channel tertentu)');
  process.exit(1);
}

const target = args[0];
const message = args.slice(1).join(' ');

const data = JSON.stringify({ target, message });

const req = http.request({
  hostname: '127.0.0.1',
  port: 45678,
  path: '/send',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  },
  timeout: 60000 // 60 detik agar cukup untuk respons AI / media
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    try {
      const resp = JSON.parse(body);
      if (resp.success) {
        console.log(`✅ [Sukses Terkirim] Ke channel ${resp.channelName || target}: "${message}"`);
        if (resp.isCommand) {
          if (resp.replyText) {
            console.log(`\n${resp.command}: ${resp.replyText}`);
          } else {
            console.log(`⚙️ [Command Selesai] Perintah "${message}" selesai diproses.`);
          }
        }
      } else {
        console.error(`❌ [Gagal Mengirim]: ${resp.error || 'Terjadi kesalahan'}`);
      }
    } catch {
      console.log(body);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Tidak dapat menghubungi bot Discord di 127.0.0.1:45678.');
  console.error('   Penyebab: Bot belum aktif berjalan atau sedang restart.');
  console.error('   Pastikan proses bot sedang aktif (node index.js).');
});

req.write(data);
req.end();
