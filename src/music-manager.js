const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType
} = require('@discordjs/voice');

// Cache SoundCloud Client ID
let cachedClientId = 'glXhJxvYKPM87la70dG2G1bJ03AdA3hN';
let lastClientIdFetch = 0;

// Format durasi detik ke MM:SS
function formatDuration(sec) {
  const s = Math.floor(sec || 0);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${m}:${remS < 10 ? '0' : ''}${remS}`;
}

// Bikin progress bar visual 🔘▬▬▬▬▬▬▬▬▬▬
function createProgressBar(currentSec, totalSec, barLength = 14) {
  if (!totalSec || totalSec <= 0) return '🔘' + '▬'.repeat(barLength);
  const percent = Math.min(Math.max(currentSec / totalSec, 0), 1);
  const progressIndex = Math.min(Math.floor(percent * barLength), barLength - 1);
  let bar = '';
  for (let i = 0; i < barLength; i++) {
    if (i === progressIndex) bar += '🔘';
    else bar += '▬';
  }
  return bar;
}

// Ambil / refresh SoundCloud Client ID
async function getSoundCloudClientId(force = false) {
  const now = Date.now();
  if (!force && cachedClientId && (now - lastClientIdFetch < 3600000)) {
    return cachedClientId;
  }
  try {
    const res = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await res.text();
    const scripts = [...html.matchAll(/<script[^>]+src="([^">]+\.js)"/g)].map(m => m[1]);
    for (const src of scripts.slice(-6)) {
      try {
        const js = await fetch(src).then(r => r.text());
        const m = js.match(/client_id[:=]["\x27]([a-zA-Z0-9]{32})["\x27]/);
        if (m) {
          cachedClientId = m[1];
          lastClientIdFetch = now;
          return cachedClientId;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return cachedClientId;
}

// Resolusi link Spotify via oEmbed + meta tags
async function resolveSpotify(url) {
  try {
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const oembed = await fetch(oembedUrl).then(r => r.json());
    let title = oembed.title || '';
    let artist = '';

    try {
      const pageHtml = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      }).then(r => r.text());
      const descMatch = pageHtml.match(/<meta property="og:description" content="([^"]+)"/);
      if (descMatch) {
        const parts = descMatch[1].split('·').map(p => p.trim());
        if (parts.length > 0 && parts[0]) {
          artist = parts[0];
        }
      }
    } catch (_) {}

    return {
      searchTerm: `${artist ? artist + ' - ' : ''}${title}`.trim(),
      title,
      artist,
      thumbnail: oembed.thumbnail_url || null,
      source: 'Spotify'
    };
  } catch (err) {
    throw new Error(`Gagal membaca metadata Spotify: ${err.message}`);
  }
}

// Resolusi link Apple Music via slug & iTunes API
async function resolveAppleMusic(url) {
  try {
    let term = '';
    const slugMatch = url.match(/\/album\/([^/]+)\//);
    if (slugMatch) {
      term = slugMatch[1].replace(/[-_]/g, ' ');
    } else {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      term = (parts[parts.length - 1] || '').replace(/[-_]/g, ' ');
    }

    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
    const itunes = await fetch(itunesUrl).then(r => r.json());
    const item = itunes.results?.[0];
    if (item) {
      return {
        searchTerm: `${item.artistName} - ${item.trackName}`,
        title: item.trackName,
        artist: item.artistName,
        thumbnail: item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '300x300bb') : null,
        source: 'Apple Music'
      };
    }
    return {
      searchTerm: term,
      title: term,
      artist: '',
      thumbnail: null,
      source: 'Apple Music'
    };
  } catch (err) {
    throw new Error(`Gagal membaca link Apple Music: ${err.message}`);
  }
}

// Resolusi langsung link SoundCloud
async function resolveSoundCloudDirect(url, requestedBy) {
  let clientId = await getSoundCloudClientId();
  const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`;
  let res = await fetch(resolveUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (res.status === 401 || res.status === 403) {
    clientId = await getSoundCloudClientId(true);
    res = await fetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
  }
  const track = await res.json();
  if (!track || !track.media) {
    throw new Error('Lagu SoundCloud tidak ditemukan.');
  }

  const unenc = track.media?.transcodings?.find(t => 
    (t.format?.protocol === 'progressive' || t.format?.protocol === 'hls') &&
    !t.format?.protocol?.includes('encrypted')
  );

  if (unenc) {
    const streamInfo = await fetch(`${unenc.url}?client_id=${clientId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }).then(r => r.json());

    const durationSec = Math.round((track.duration || 0) / 1000);
    return {
      title: track.title,
      artist: track.user?.username || 'SoundCloud Artist',
      durationSec,
      durationText: formatDuration(durationSec),
      url: track.permalink_url || url,
      streamUrl: streamInfo.url,
      thumbnail: track.artwork_url || track.user?.avatar_url || null,
      source: 'SoundCloud',
      requestedBy: requestedBy || 'User'
    };
  }

  // Jika lagu Go+ / terenkripsi DRM, fallback cari versi publiknya di SoundCloud
  return await searchAndResolveSoundCloud(track.title, requestedBy, {
    title: track.title,
    artist: track.user?.username,
    thumbnail: track.artwork_url,
    source: 'SoundCloud'
  });
}

// Cari lagu dan ambil stream audio di SoundCloud
async function searchAndResolveSoundCloud(query, requestedBy, originalMeta = null) {
  let clientId = await getSoundCloudClientId();
  const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=10`;
  let res = await fetch(searchUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });

  if (res.status === 401 || res.status === 403) {
    clientId = await getSoundCloudClientId(true);
    res = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=10`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
  }

  const data = await res.json();
  const collection = data.collection || [];
  if (collection.length === 0) {
    throw new Error(`Tidak ditemukan lagu untuk "${query}". Coba judul atau kata kunci lain.`);
  }

  let chosenTrack = null;
  let chosenTranscoding = null;

  for (const track of collection) {
    const unenc = track.media?.transcodings?.find(t => 
      (t.format?.protocol === 'progressive' || t.format?.protocol === 'hls') &&
      !t.format?.protocol?.includes('encrypted')
    );
    if (unenc) {
      chosenTrack = track;
      chosenTranscoding = unenc;
      break;
    }
  }

  if (!chosenTrack || !chosenTranscoding) {
    throw new Error(`Lagu "${query}" ditemukan tetapi tidak dapat distreaming (DRM terlindungi).`);
  }

  const streamInfo = await fetch(`${chosenTranscoding.url}?client_id=${clientId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  }).then(r => r.json());

  if (!streamInfo.url) {
    throw new Error('Gagal mendapatkan stream audio lagu.');
  }

  const durationSec = Math.round((chosenTrack.duration || 0) / 1000);

  return {
    title: originalMeta?.title || chosenTrack.title,
    artist: originalMeta?.artist || chosenTrack.user?.username || 'Artis Tidak Diketahui',
    durationSec,
    durationText: formatDuration(durationSec),
    url: chosenTrack.permalink_url,
    streamUrl: streamInfo.url,
    thumbnail: originalMeta?.thumbnail || chosenTrack.artwork_url || chosenTrack.user?.avatar_url || null,
    source: originalMeta?.source || 'SoundCloud',
    requestedBy: requestedBy || 'User'
  };
}

// Master resolver: mengenali tipe input dan mengembalikan objek track
async function resolveTrack(input, requestedBy) {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new Error('Mohon masukkan judul lagu atau link (Spotify / SoundCloud / Apple Music).');

  // 1. Spotify URL
  if (/https?:\/\/(open\.)?spotify\.com\/(intl-[a-z]+\/)?track\/[a-zA-Z0-9]+/i.test(trimmed)) {
    const meta = await resolveSpotify(trimmed);
    return await searchAndResolveSoundCloud(meta.searchTerm, requestedBy, meta);
  }

  // 2. Apple Music URL
  if (/https?:\/\/music\.apple\.com\//i.test(trimmed)) {
    const meta = await resolveAppleMusic(trimmed);
    return await searchAndResolveSoundCloud(meta.searchTerm, requestedBy, meta);
  }

  // 3. SoundCloud URL
  if (/https?:\/\/(www\.)?soundcloud\.com\/[^/]+\/[^/]+/i.test(trimmed)) {
    return await resolveSoundCloudDirect(trimmed, requestedBy);
  }

  // 4. Direct Audio URL (mp3, wav, ogg, m4a, flac, aac)
  if (/^https?:\/\/.+\.(mp3|wav|ogg|m4a|aac|flac)(\?.*)?$/i.test(trimmed)) {
    const urlObj = new URL(trimmed);
    const fileName = path.basename(urlObj.pathname);
    return {
      title: decodeURIComponent(fileName) || 'Direct Audio Stream',
      artist: urlObj.hostname,
      durationSec: 0,
      durationText: 'Live / Unknown',
      url: trimmed,
      streamUrl: trimmed,
      thumbnail: null,
      source: 'Direct Link',
      requestedBy: requestedBy || 'User'
    };
  }

  // 5. Text search biasa
  return await searchAndResolveSoundCloud(trimmed, requestedBy);
}

// ==========================================
// GUILD QUEUE & PLAYBACK SYSTEM
// ==========================================

const guildQueues = new Map(); // guildId -> QueueState

class GuildQueue {
  constructor(guildId, client) {
    this.guildId = guildId;
    this.client = client;
    this.voiceChannel = null;
    this.textChannel = null;
    this.connection = null;
    this.player = null;
    this.queue = [];
    this.current = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.volume = 1.0;
    this.playbackStartTime = 0;
    this.pauseStartTime = 0;
    this.totalPausedDuration = 0;
    this.currentFfmpeg = null;
    this.idleTimer = null;
  }

  initPlayer() {
    if (this.player) return;
    this.player = createAudioPlayer();

    this.player.on(AudioPlayerStatus.Playing, () => {
      this.isPlaying = true;
      this.isPaused = false;
      this.playbackStartTime = Date.now();
      this.totalPausedDuration = 0;
      this.clearIdleTimer();
    });

    this.player.on(AudioPlayerStatus.Paused, () => {
      this.isPaused = true;
      this.pauseStartTime = Date.now();
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
      this.isPaused = false;
      this.killFfmpeg();

      // Putar lagu berikutnya jika ada antrian
      if (this.queue.length > 0) {
        this.current = this.queue.shift();
        this.startStream(this.current);
        if (this.textChannel) {
          const embed = {
            color: 0x5865F2,
            title: '🎶 Sekarang Memutar',
            description: `[**${this.current.title}**](${this.current.url || 'https://discord.com'})\nArtis: **${this.current.artist}**\nDurasi: \`${this.current.durationText}\` • Sumber: **${this.current.source}**\nDiminta oleh: **${this.current.requestedBy}**`,
            thumbnail: this.current.thumbnail ? { url: this.current.thumbnail } : undefined,
            footer: { text: `Volume: ${Math.round(this.volume * 100)}% • Sisa antrian: ${this.queue.length} lagu` }
          };
          this.textChannel.send({ embeds: [embed] }).catch(() => {});
        }
      } else {
        this.current = null;
        this.startIdleTimer();
      }
    });

    this.player.on('error', (err) => {
      console.error(`[Music Player Error in ${this.guildId}]:`, err.message);
      this.killFfmpeg();
      if (this.textChannel) {
        this.textChannel.send(`⚠️ Error saat memutar lagu: ${err.message}`).catch(() => {});
      }
      // Lanjut ke lagu berikutnya
      if (this.queue.length > 0) {
        this.current = this.queue.shift();
        this.startStream(this.current);
      } else {
        this.current = null;
        this.startIdleTimer();
      }
    });
  }

  connectVoice(voiceChannel) {
    this.voiceChannel = voiceChannel;
    this.initPlayer();

    if (!this.connection || this.connection.state.status === VoiceConnectionStatus.Destroyed) {
      this.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: this.guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
      });

      this.connection.subscribe(this.player);

      this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(this.connection, VoiceConnectionStatus.Connecting, 5000)
          ]);
        } catch {
          this.destroy();
        }
      });
    } else if (this.connection.joinConfig.channelId !== voiceChannel.id) {
      this.connection.rejoin({
        channelId: voiceChannel.id,
        selfDeaf: true
      });
    }
  }

  startStream(track) {
    this.killFfmpeg();

    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', track.streamUrl,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ];

    const ffmpegProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.currentFfmpeg = ffmpegProc;

    const resource = createAudioResource(ffmpegProc.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });

    if (resource.volume) {
      resource.volume.setVolume(this.volume);
    }
    this.currentResource = resource;

    ffmpegProc.on('close', () => {
      if (this.currentFfmpeg === ffmpegProc) {
        this.currentFfmpeg = null;
      }
    });

    this.player.play(resource);
  }

  killFfmpeg() {
    if (this.currentFfmpeg) {
      try {
        this.currentFfmpeg.kill('SIGKILL');
      } catch (_) {}
      this.currentFfmpeg = null;
    }
  }

  startIdleTimer() {
    this.clearIdleTimer();
    // Auto keluar setelah 3 menit menganggur
    this.idleTimer = setTimeout(() => {
      if (this.textChannel) {
        this.textChannel.send('👋 Antrian musik selesai. Bot keluar dari Voice Channel karena idle.').catch(() => {});
      }
      this.destroy();
    }, 180000);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  destroy() {
    this.clearIdleTimer();
    this.killFfmpeg();
    this.queue = [];
    this.current = null;
    this.isPlaying = false;
    this.isPaused = false;

    if (this.player) {
      try { this.player.stop(true); } catch (_) {}
    }
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try { this.connection.destroy(); } catch (_) {}
    }
    guildQueues.delete(this.guildId);
  }
}

// Handler utama perintah Play / Music
async function playMusic({ guild, textChannel, voiceChannel, query, requestedBy, customBuffer = null, customFileName = '' }) {
  let queueState = guildQueues.get(guild.id);
  if (!queueState) {
    queueState = new GuildQueue(guild.id, guild.client);
    guildQueues.set(guild.id, queueState);
  }

  queueState.textChannel = textChannel;
  queueState.connectVoice(voiceChannel);

  // Tunggu koneksi ready
  await entersState(queueState.connection, VoiceConnectionStatus.Ready, 10000);

  let track = null;

  // Jika input berupa buffer custom (file upload / voice note)
  if (customBuffer) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music_upload_'));
    const tmpPath = path.join(tmpDir, 'audio.raw');
    fs.writeFileSync(tmpPath, customBuffer);
    track = {
      title: customFileName || 'Audio Upload Discord',
      artist: requestedBy,
      durationSec: 0,
      durationText: 'Custom File',
      url: 'https://discord.com',
      streamUrl: tmpPath,
      thumbnail: null,
      source: 'Upload File',
      requestedBy,
      isLocalFile: true,
      cleanup: () => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      }
    };
  } else {
    track = await resolveTrack(query, requestedBy);
  }

  // Jika sedang memutar lagu lain, masukkan ke antrian
  if (queueState.isPlaying || queueState.current) {
    queueState.queue.push(track);
    return {
      queued: true,
      position: queueState.queue.length,
      track
    };
  }

  // Jika belum ada lagu yang diputar, langsung putar
  queueState.current = track;
  queueState.startStream(track);
  return {
    queued: false,
    track
  };
}

// Lewati lagu (Skip)
function skipMusic(guildId) {
  const queueState = guildQueues.get(guildId);
  if (!queueState || !queueState.current) {
    return false;
  }
  const skippedTrack = queueState.current;
  queueState.player.stop(true); // ini akan memicu event Idle -> putar lagu berikutnya otomatis
  return skippedTrack;
}

// Jeda (Pause)
function pauseMusic(guildId) {
  const queueState = guildQueues.get(guildId);
  if (!queueState || !queueState.isPlaying || queueState.isPaused) {
    return false;
  }
  return queueState.player.pause();
}

// Lanjutkan (Resume)
function resumeMusic(guildId) {
  const queueState = guildQueues.get(guildId);
  if (!queueState || !queueState.isPaused) {
    return false;
  }
  if (queueState.pauseStartTime) {
    queueState.totalPausedDuration += (Date.now() - queueState.pauseStartTime);
    queueState.pauseStartTime = 0;
  }
  return queueState.player.unpause();
}

// Stop dan keluar
function stopMusic(guildId) {
  const queueState = guildQueues.get(guildId);
  if (!queueState) return false;
  queueState.destroy();
  return true;
}

// Ambil info Now Playing
function getNowPlaying(guildId) {
  const queueState = guildQueues.get(guildId);
  if (!queueState || !queueState.current) return null;

  const current = queueState.current;
  let elapsedSec = 0;
  if (queueState.playbackStartTime > 0) {
    const activeElapsed = queueState.isPaused
      ? (queueState.pauseStartTime - queueState.playbackStartTime - queueState.totalPausedDuration)
      : (Date.now() - queueState.playbackStartTime - queueState.totalPausedDuration);
    elapsedSec = Math.max(0, Math.floor(activeElapsed / 1000));
  }

  const progressBar = createProgressBar(elapsedSec, current.durationSec);

  return {
    track: current,
    isPlaying: queueState.isPlaying,
    isPaused: queueState.isPaused,
    elapsedSec,
    elapsedText: formatDuration(elapsedSec),
    totalSec: current.durationSec,
    totalText: current.durationText,
    progressBar,
    volume: Math.round(queueState.volume * 100),
    queueCount: queueState.queue.length
  };
}

// Ambil list antrian lagu
function getQueueList(guildId) {
  const queueState = guildQueues.get(guildId);
  if (!queueState || (!queueState.current && queueState.queue.length === 0)) {
    return null;
  }
  return {
    current: queueState.current,
    queue: queueState.queue,
    totalCount: queueState.queue.length + (queueState.current ? 1 : 0),
    isPaused: queueState.isPaused,
    volume: Math.round(queueState.volume * 100)
  };
}

// Set volume lagu (1 - 150%)
function setMusicVolume(guildId, volumePercent) {
  const queueState = guildQueues.get(guildId);
  if (!queueState) return false;

  const vol = Math.min(Math.max(parseInt(volumePercent) || 100, 1), 150);
  queueState.volume = vol / 100;

  if (queueState.currentResource && queueState.currentResource.volume) {
    queueState.currentResource.volume.setVolume(queueState.volume);
  }
  return vol;
}

module.exports = {
  resolveTrack,
  playMusic,
  skipMusic,
  pauseMusic,
  resumeMusic,
  stopMusic,
  getNowPlaying,
  getQueueList,
  setMusicVolume,
  formatDuration,
  createProgressBar
};
