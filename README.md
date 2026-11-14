# 🤖 TuffBot Discord

Multi-feature Discord Bot modern & lengkap dengan AI Memori & Custom Persona, Image Enhancer (.hd), Brat Sticker (.brat & .bratvid), Quote Chat (.qc), Downloader, Utilitas, dan Mini Games.

---

## ✨ Fitur Utama

- 🧠 **AI & Custom Persona:**
  - `.ai <tanya>`: AI interaktif dengan memori riwayat chat
  - `.persona <watak>`: Custom kepribadian bot untuk masing-masing user
  - `.mypersona`: Lihat watak aktif
  - `.resetai`: Bersihkan memori percakapan
- 🎨 **Olah Media & Stiker:**
  - `.s`: Konversi gambar (lampiran atau reply) ke stiker WebP
  - `.toimg`: Ubah stiker kembali ke foto JPEG
  - `.hd` / `.remini`: Tingkatkan resolusi/kualitas foto (AI Upscaling)
  - `.brat <teks>`: Stiker gaya Brat estetik putih
  - `.bratvid <teks>`: Stiker video animasi Brat per-kata
  - `.qc <teks>`: Buat quote chat stiker dengan avatar Discord user
  - `.smeme <atas|bawah>`: Stiker meme kustom
  - `.ttp` & `.attp`: Stiker teks bercahaya / bergerak
- 🔊 **Audio & TTS:**
  - `.tts <teks>`: Text-to-speech Google Indonesia (MP3)
  - Efek audio: `.bass`, `.slow`, `.robot`, `.chipmunk`
- 📥 **Downloader & Search:**
  - `.tiktok <url>`: Download video TikTok tanpa watermark
  - `.pin <query>` / `.img <query>`: Pencarian gambar Pinterest & Google
- 🛠️ **Informasi & Utilitas:**
  - `.cuaca <kota>`, `.sholat <kota>`, `.surah <nomor>`, `.gempa` (BMKG)
  - `.calc <hitungan>`, `.wiki <query>`, `.qr <teks>`, `.short <url>`, `.ssweb <url>`
- 🎮 **Mini Games & Hiburan:**
  - `.tebakkata`: Kuis tebak kata berbatas waktu 60 detik
  - `.dadu`, `.koin`, `.apakah`, `.rate`, `.siapakah`
- 💻 **Console Control:**
  - `node send.js default <pesan/command>`: Kontrol dan kirim perintah langsung dari console panel hosting!

---

## 🚀 Setup & Konfigurasi

1. Aktifkan **Message Content Intent** di [Discord Developer Portal](https://discord.com/developers/applications) -> Tab **Bot** -> **Privileged Gateway Intents**.
2. Simpan token bot di file `.env`:
   ```env
   DISCORD_TOKEN=your_bot_token_here
   BOT_PREFIX=.
   ```
3. Jalankan bot:
   ```bash
   node index.js
   ```
