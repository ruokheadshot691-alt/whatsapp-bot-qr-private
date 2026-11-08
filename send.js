#!/usr/bin/env node

/**
 * Script CLI pengirim pesan WhatsApp langsung dari console / bash terminal.
 * Berkomunikasi dengan bot yang sedang aktif via local HTTP IPC (port 45678).
 *
 * Contoh penggunaan:
 *   send me Halo pesan untuk nomor bot sendiri!
 *   send 085281929641 Halo apa kabar!
 *   ./send 085281929641 Halo apa kabar!
 *   node send.js 085281929641 Halo apa kabar!
 */

const http = require('http');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('⚠️ Format penggunaan salah!');
  console.log('   send <nomor/target> <pesan>');
  console.log('Contoh:');
  console.log('   send me Halo ini catatan untuk bot sendiri');
  console.log('   send 085281929641 Halo ini pesan dari console!');
  console.log('   send 1203630234567890@g.us Halo semua anggota grup!');
  console.log('   send owner Halo owner bot!');
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
  timeout: 10000
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    try {
      const resp = JSON.parse(body);
      if (resp.success) {
        const dest = resp.isSelf ? `${resp.jid} (Nomor Sendiri)` : (resp.jid || target);
        console.log(`✅ [Sukses Terkirim] Pesan ke ${dest}: "${message}"`);
      } else {
        console.error(`❌ [Gagal Mengirim]: ${resp.error || 'Terjadi kesalahan'}`);
      }
    } catch {
      console.log(body);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Tidak dapat menghubungi bot WhatsApp di 127.0.0.1:45678.');
  console.error('   Penyebab: Bot belum aktif berjalan atau sedang restart.');
  console.error('   Pastikan proses bot sedang aktif (node index.js).');
});

req.write(data);
req.end();
