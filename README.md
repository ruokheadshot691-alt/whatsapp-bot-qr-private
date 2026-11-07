# WhatsApp Bot (Baileys) - Scan QR

Bot WhatsApp multifitur dengan sistem otentikasi Scan QR, dilengkapi proteksi Anti-Banned, pengubah stiker, AI photo upscaling, dan berbagai utilitas.

---

## 🚀 Fitur Utama
- **`.brat <teks>`** : Membuat stiker teks Brat dengan background putih dan teks hitam (khas album Brat).
- **`.bratvid <teks>`** : Membuat stiker video/animasi Brat di mana katanya muncul satu per satu hingga selesai.
- **`.s` / `.sticker`** : Kirim gambar langsung atau balas (*reply*) pesan gambar orang lain untuk diubah menjadi stiker WhatsApp WebP transparan 512x512.
- **`.hd` / `.remini`** : Kirim atau balas gambar untuk di-upscale / diperjelas menggunakan AI. Dilengkapi fallback sharpening otomatis jika server AI eksternal offline.
- **`.menu` / `.help`** : Menampilkan daftar lengkap fitur dan cara pakainya.
- **`.ping`** : Menguji latensi respons bot (dalam milidetik).
- **`.calc <rumus>`** : Menghitung operasi matematika cepat langsung di chat (contoh: `.calc 150000 * 0.12`).
- **`.runtime`** : Melihat sudah berapa lama bot menyala nonstop.
- **Grup (admin):** `.kick`, `.promote`, `.demote`, `.mute`, `.unmute`, `.tagall`, `.groupinfo`. Bot dan pengirim harus memiliki peran admin sesuai tindakan.
- **`.owner`** : Menampilkan nomor kontak pemilik bot.

---

## 🔐 Keamanan Sesi WhatsApp
- Folder `session/` berisi kredensial login yang setara dengan sesi tertaut. Jangan pernah bagikan, upload, atau commit folder ini ke GitHub.
- `.gitignore` mengecualikan folder sesi dan file rahasia. Repository dibuat privat sebagai lapisan tambahan, bukan pengganti pengamanan.
- Simpan folder sesi pada penyimpanan persisten server dan batasi akses file. Jika sesi terpapar, keluarkan perangkat tertaut dari WhatsApp dan buat sesi baru.
- QR scan hanya perlu saat login pertama atau sesi di-reset; jangan kirim QR ke orang lain.

## 🛡️ Proteksi Anti-Spam
1. **Human-like Delay (`composing`)** : Sebelum membalas, bot memunculkan status "sedang mengetik..." dengan jeda acak (800 ms - 2000 ms) agar aktivitasnya tidak terbaca seperti mesin spam oleh server WhatsApp.
2. **User Cooldown System** : Pengguna tidak bisa mengirim rentetan perintah berturut-turut tanpa jeda (default 3.5 detik per perintah).
3. **Rate Limiting** : Dibatasi maksimal 15 perintah per menit per orang untuk mencegah grup membombardir bot.
4. **Browser Desktop Spoofing** : Menggunakan identitas browser macOS Desktop resmi sehingga terdaftar sebagai WhatsApp Web asli.
5. **Smart Error Handling** : Sesi reconnect otomatis saat terputus jaringan tanpa menghapus kredensial login.

---

## 📦 Cara Menjalankan

### Cara 1: Di HP Android (Termux)
1. Install Termux dari F-Droid.
2. Jalankan perintah:
   ```bash
   pkg update && pkg install nodejs-lts git ffmpeg
   ```
3. Pindahkan file bot ini ke folder Termux.
4. Jalankan:
   ```bash
   npm install
   node index.js
   ```
5. Scan QR code yang tampil di layar Termux.

### Cara 2: Di VPS / Hosting RAM Rendah (256 MB)
1. Push proyek ini ke repositori GitHub kamu.
2. Jalankan **GitHub Actions** (`Build Linux x64 Dependencies`).
3. Unduh artifact `node_modules-linux-x64.tar.gz`.
4. Upload file tersebut ke panel hosting bersama file bot ini, lalu ekstrak:
   ```bash
   tar -xzf node_modules-linux-x64.tar.gz
   node index.js
   ```
5. Scan QR di console panel hosting.


---

## 💻 Fitur Console Panel (bot-hosting.net)
Kamu bisa mengetik langsung di kotak terminal / console panel server untuk mengirim pesan tanpa perlu chat dari WA:
* `send <nomor/grup> <pesan>` : Kirim pesan ke nomor tujuan atau grup.
  * Contoh: `send 081234567890 Halo dari console!`
  * Contoh: `send 1203630234567890@g.us Halo semua anggota grup!`
  * Contoh: `send me Catatan untuk nomor bot sendiri`
  * Contoh: `send owner Halo owner!`
* `<nomor> <pesan>` (shortcut): Langsung ketik nomor dan pesannya (misal: `081234567890 Tes pesan cepat`).
* `status` : Cek status koneksi bot, nomor aktif, uptime, dan penggunaan RAM container.
* `eval <kode>` : Menjalankan cuplikan kode JavaScript langsung di runtime server.
* `help` : Menampilkan ringkasan panduan console.
