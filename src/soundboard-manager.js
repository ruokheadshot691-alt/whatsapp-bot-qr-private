const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/discordjs/discord.js, 14.16.3)';

/**
 * Konversi dan potong audio menjadi format Soundboard Discord:
 * - Durasi maksimal: 4.8 - 5.0 detik (batas keras Discord adalah 5.20 detik, 4.8 detik mencegah buffer overfill / padding LAME)
 * - Format: MP3 (libmp3lame, 44.1kHz)
 * - Ukuran maksimal: < 512 KB
 */
function convertAudioToSoundboardBuffer(inputBuffer, options = {}) {
  const { startSec = 0, durationSec = 4.8 } = options;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundboard_'));
  const inPath = path.join(tmpDir, 'input.raw');
  const outPath = path.join(tmpDir, 'output.mp3');

  try {
    fs.writeFileSync(inPath, inputBuffer);
    
    // Potong & konversi ke MP3 128k
    const ss = Math.max(0, parseFloat(startSec) || 0);
    const dur = Math.min(4.8, Math.max(0.5, parseFloat(durationSec) || 4.8));
    
    // Gunakan filter atrim dan -t setelah -i agar hasil tepat 4.8 detik tanpa melebihi batas 5.2s Discord
    const cmd = `ffmpeg -y -ss ${ss} -i "${inPath}" -t ${dur} -af "atrim=0:${dur},asetpts=PTS-STARTPTS" -vn -c:a libmp3lame -b:a 128k -ar 44100 "${outPath}"`;
    execSync(cmd, { stdio: 'pipe' });

    let outBuf = fs.readFileSync(outPath);
    
    // Jika ukuran > 500KB (batas Discord 512KB), kompres dengan bitrate lebih hemat
    if (outBuf.length > 500 * 1024) {
      const fallbackCmd = `ffmpeg -y -ss ${ss} -i "${inPath}" -t ${dur} -af "atrim=0:${dur},asetpts=PTS-STARTPTS" -vn -c:a libmp3lame -b:a 64k -ar 32000 "${outPath}"`;
      execSync(fallbackCmd, { stdio: 'pipe' });
      outBuf = fs.readFileSync(outPath);
    }

    return outBuf;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Tambahkan soundboard sound baru ke server Discord
 */
async function createSoundboardSound(token, guildId, options) {
  const { name, audioBuffer, emojiName = '🔊', startSec = 0 } = options;
  
  if (!name || name.trim().length < 2) {
    throw new Error('Nama soundboard minimal 2 karakter (maksimal 32 karakter).');
  }

  // Bersihkan nama (hanya alfanumerik, spasi, underscore)
  const cleanName = name.trim().replace(/[^a-zA-Z0-9_\s-]/g, '').slice(0, 32).trim() || 'sound';

  // Konversi audio dengan ffmpeg
  const mp3Buffer = convertAudioToSoundboardBuffer(audioBuffer, { startSec });
  const base64Audio = `data:audio/mp3;base64,${mp3Buffer.toString('base64')}`;

  const payload = {
    name: cleanName,
    sound: base64Audio,
    volume: 1.0,
    emoji_name: emojiName || '🔊'
  };

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/soundboard-sounds`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    const errorText = await res.text();
    let parsed;
    try { parsed = JSON.parse(errorText); } catch (_) {}
    const msg = parsed?.message || errorText;
    throw new Error(`Gagal membuat soundboard: ${msg}`);
  }

  return await res.json();
}

/**
 * Ambil daftar soundboard sounds dari server Discord
 */
async function listSoundboardSounds(token, guildId) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/soundboard-sounds`, {
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': USER_AGENT
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gagal mengambil daftar soundboard: ${errorText}`);
  }

  const data = await res.json();
  return data?.items || [];
}

/**
 * Putar soundboard sound langsung ke Voice Channel
 */
async function playSoundboardInVoice(token, voiceChannelId, soundId, sourceGuildId = null) {
  const payload = { sound_id: soundId };
  if (sourceGuildId) {
    payload.source_guild_id = sourceGuildId;
  }

  const res = await fetch(`${DISCORD_API}/channels/${voiceChannelId}/send-soundboard-sound`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const errorText = await res.text();
    let parsed;
    try { parsed = JSON.parse(errorText); } catch (_) {}
    const msg = parsed?.message || errorText;
    throw new Error(`Gagal memutar soundboard di Voice Channel: ${msg}`);
  }

  return true;
}

/**
 * Hapus soundboard sound dari server Discord
 */
async function deleteSoundboardSound(token, guildId, soundId) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/soundboard-sounds/${soundId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': USER_AGENT
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok && res.status !== 204) {
    const errorText = await res.text();
    throw new Error(`Gagal menghapus soundboard: ${errorText}`);
  }

  return true;
}

module.exports = {
  convertAudioToSoundboardBuffer,
  createSoundboardSound,
  listSoundboardSounds,
  playSoundboardInVoice,
  deleteSoundboardSound
};
