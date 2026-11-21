/**
 * Uno Game Manager - Multiplayer up to 8 players
 */

const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];

function createDeck() {
  const deck = [];
  let idCounter = 1;

  for (const color of COLORS) {
    // Satu kartu 0 per warna
    deck.push({ id: `c_${idCounter++}`, color, value: '0', type: 'number' });

    // Dua kartu untuk 1-9 dan action per warna
    for (const val of VALUES.slice(1)) {
      const type = ['skip', 'reverse', 'draw2'].includes(val) ? 'action' : 'number';
      deck.push({ id: `c_${idCounter++}`, color, value: val, type });
      deck.push({ id: `c_${idCounter++}`, color, value: val, type });
    }
  }

  // 4 Wild & 4 Wild Draw Four
  for (let i = 0; i < 4; i++) {
    deck.push({ id: `c_${idCounter++}`, color: 'wild', value: 'wild', type: 'wild' });
    deck.push({ id: `c_${idCounter++}`, color: 'wild', value: 'wild4', type: 'wild4' });
  }

  return shuffle(deck);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class UnoRoom {
  constructor(roomId, hostId, hostName, hostAvatar) {
    this.roomId = roomId;
    this.hostId = hostId;
    this.status = 'waiting'; // 'waiting', 'playing', 'finished'
    this.players = [
      {
        id: hostId,
        name: hostName || 'Host',
        avatar: hostAvatar || '',
        hand: [],
        saidUno: false,
        score: 0
      }
    ];
    this.maxPlayers = 8;
    this.deck = [];
    this.discardPile = [];
    this.currentTurnIndex = 0;
    this.direction = 1; // 1: searah jarum jam, -1: berlawanan
    this.currentColor = null;
    this.currentValue = null;
    this.drawStack = 0; // untuk akumulasi +2 / +4 jika ingin stacking
    this.turnTimer = null;
    this.turnTimeoutSec = 30;
    this.turnExpiresAt = null;
    this.logs = [`Lobby dibuat oleh ${hostName || 'Host'}. Menunggu pemain lain (Maks 8)...`];
    this.winner = null;
    this.subscribers = new Set(); // SSE client listeners
    this.createdAt = Date.now();
  }

  addPlayer(id, name, avatar) {
    if (this.status !== 'waiting') return { success: false, error: 'Permainan sudah dimulai!' };
    if (this.players.length >= this.maxPlayers) return { success: false, error: 'Kamar sudah penuh (Maks 8 pemain)!' };
    if (this.players.some(p => p.id === id)) return { success: false, error: 'Kamu sudah bergabung dalam kamar ini!' };

    this.players.push({
      id,
      name: name || `Pemain ${this.players.length + 1}`,
      avatar: avatar || '',
      hand: [],
      saidUno: false,
      score: 0
    });

    this.addLog(`${name} bergabung ke dalam lobi (${this.players.length}/${this.maxPlayers}).`);
    this.broadcast();
    return { success: true, room: this };
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return { success: false, error: 'Pemain tidak ditemukan.' };

    const leavingPlayer = this.players[idx];
    this.addLog(`${leavingPlayer.name} meninggalkan kamar.`);

    if (this.status === 'playing') {
      // Kembalikan kartunya ke dek
      if (leavingPlayer.hand.length > 0) {
        this.deck.push(...leavingPlayer.hand);
        this.deck = shuffle(this.deck);
      }
      this.players.splice(idx, 1);

      if (this.players.length < 2) {
        this.status = 'finished';
        this.winner = this.players[0] || null;
        this.addLog(`Pemain tersisa kurang dari 2. Permainan selesai! ${this.winner ? this.winner.name + ' dinyatakan menang.' : ''}`);
        this.clearTurnTimer();
      } else {
        if (this.currentTurnIndex >= this.players.length) {
          this.currentTurnIndex = 0;
        }
        this.resetTurnTimer();
      }
    } else {
      this.players.splice(idx, 1);
      // Ganti host jika host keluar
      if (this.hostId === id && this.players.length > 0) {
        this.hostId = this.players[0].id;
        this.addLog(`Host berganti kepada ${this.players[0].name}.`);
      }
    }

    this.broadcast();
    return { success: true, remainingPlayers: this.players.length };
  }

  startGame(requestingUserId) {
    if (this.hostId !== requestingUserId) return { success: false, error: 'Hanya host kamar yang dapat memulai permainan!' };
    if (this.players.length < 2) return { success: false, error: 'Dibutuhkan minimal 2 pemain untuk memulai UNO!' };
    if (this.status !== 'waiting') return { success: false, error: 'Permainan sudah berjalan atau selesai.' };

    this.deck = createDeck();
    this.discardPile = [];
    this.direction = 1;
    this.currentTurnIndex = Math.floor(Math.random() * this.players.length);

    // Bagikan 7 kartu per pemain
    for (const player of this.players) {
      player.hand = this.deck.splice(0, 7);
      player.saidUno = false;
    }

    // Ambil kartu pertama untuk discard pile (hindari kartu wild pertama)
    let firstCard = this.deck.pop();
    while (firstCard.color === 'wild') {
      this.deck.unshift(firstCard);
      this.deck = shuffle(this.deck);
      firstCard = this.deck.pop();
    }

    this.discardPile.push(firstCard);
    this.currentColor = firstCard.color;
    this.currentValue = firstCard.value;
    this.status = 'playing';

    const activePlayer = this.getCurrentPlayer();
    this.addLog(`🎲 Permainan UNO dimulai! Kartu awal: ${this.cardToString(firstCard)}.`);
    this.addLog(`👉 Giliran pertama: ${activePlayer.name}`);

    // Efek kartu pertama jika action
    if (firstCard.value === 'skip') {
      this.advanceTurn();
      this.addLog(`Kartu awal Skip! Giliran berpindah ke ${this.getCurrentPlayer().name}.`);
    } else if (firstCard.value === 'reverse') {
      this.direction *= -1;
      if (this.players.length === 2) {
        this.advanceTurn();
      }
      this.addLog(`Kartu awal Reverse! Arah putaran dibalik.`);
    } else if (firstCard.value === 'draw2') {
      const victim = this.getCurrentPlayer();
      this.giveCards(victim, 2);
      this.advanceTurn();
      this.addLog(`Kartu awal Draw Two! ${victim.name} mengambil 2 kartu.`);
    }

    this.resetTurnTimer();
    this.broadcast();
    return { success: true };
  }

  getCurrentPlayer() {
    return this.players[this.currentTurnIndex];
  }

  advanceTurn() {
    const len = this.players.length;
    this.currentTurnIndex = (this.currentTurnIndex + this.direction + len) % len;
    this.resetTurnTimer();
  }

  resetTurnTimer() {
    this.clearTurnTimer();
    this.turnExpiresAt = Date.now() + (this.turnTimeoutSec * 1000);
    this.turnTimer = setTimeout(() => {
      this.handleTurnTimeout();
    }, this.turnTimeoutSec * 1000);
    if (this.turnTimer && this.turnTimer.unref) this.turnTimer.unref();
  }

  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnExpiresAt = null;
  }

  handleTurnTimeout() {
    if (this.status !== 'playing') return;
    const player = this.getCurrentPlayer();
    this.addLog(`⏰ Waktu ${player.name} habis! Otomatis mengambil 1 kartu.`);
    this.drawCard(player.id, true); // force pass after auto-draw
  }

  drawCard(playerId, autoAdvance = false) {
    if (this.status !== 'playing') return { success: false, error: 'Game belum dimulai.' };
    const currentPlayer = this.getCurrentPlayer();
    if (currentPlayer.id !== playerId) return { success: false, error: 'Bukan giliranmu!' };

    if (this.deck.length === 0) {
      this.reshuffleDiscardIntoDeck();
    }

    if (this.deck.length === 0) {
      return { success: false, error: 'Semua kartu telah habis di dek!' };
    }

    const card = this.deck.pop();
    currentPlayer.hand.push(card);
    currentPlayer.saidUno = false;
    this.addLog(`${currentPlayer.name} mengambil 1 kartu dari dek.`);

    if (autoAdvance) {
      this.advanceTurn();
      this.addLog(`👉 Giliran selanjutnya: ${this.getCurrentPlayer().name}`);
    }

    this.broadcast();
    return { success: true, drawnCard: card };
  }

  passTurn(playerId) {
    if (this.status !== 'playing') return { success: false, error: 'Game belum dimulai.' };
    const currentPlayer = this.getCurrentPlayer();
    if (currentPlayer.id !== playerId) return { success: false, error: 'Bukan giliranmu!' };

    this.addLog(`${currentPlayer.name} mengoper giliran.`);
    this.advanceTurn();
    this.addLog(`👉 Giliran selanjutnya: ${this.getCurrentPlayer().name}`);
    this.broadcast();
    return { success: true };
  }

  playCard(playerId, cardId, chosenColor) {
    if (this.status !== 'playing') return { success: false, error: 'Game belum berjalan.' };
    const currentPlayer = this.getCurrentPlayer();
    if (currentPlayer.id !== playerId) return { success: false, error: 'Bukan giliranmu saat ini!' };

    const cardIndex = currentPlayer.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return { success: false, error: 'Kartu tidak ada di tanganmu.' };

    const card = currentPlayer.hand[cardIndex];

    // Validasi apakah kartu cocok
    const isWild = card.color === 'wild';
    const isColorMatch = card.color === this.currentColor;
    const isValueMatch = card.value === this.currentValue;

    if (!isWild && !isColorMatch && !isValueMatch) {
      return {
        success: false,
        error: `Kartu tidak valid! Harus warna ${this.colorName(this.currentColor)} atau nilai/aksi ${this.currentValue}.`
      };
    }

    if (isWild && !chosenColor) {
      return { success: false, error: 'Kamu harus memilih warna baru (Merah, Biru, Hijau, Kuning).' };
    }

    // Mainkan kartu
    currentPlayer.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.currentValue = card.value;

    if (isWild) {
      this.currentColor = chosenColor;
      this.addLog(`${currentPlayer.name} memainkan ${this.cardToString(card)} dan memilih warna ${this.colorName(chosenColor)}!`);
    } else {
      this.currentColor = card.color;
      this.addLog(`${currentPlayer.name} memainkan ${this.cardToString(card)}.`);
    }

    // Cek apakah pemain menang
    if (currentPlayer.hand.length === 0) {
      this.status = 'finished';
      this.winner = currentPlayer;
      this.clearTurnTimer();
      this.addLog(`🏆 SELAMAT! ${currentPlayer.name} berhasil menghabiskan semua kartu dan memenangkan UNO!`);
      this.broadcast();
      return { success: true, won: true, winner: currentPlayer };
    }

    // Peringatan kartu tinggal 1 (UNO)
    if (currentPlayer.hand.length === 1) {
      if (currentPlayer.saidUno) {
        this.addLog(`🔥 ${currentPlayer.name} berteriak "UNO!" (Tersisa 1 kartu!)`);
      } else {
        this.addLog(`⚠️ ${currentPlayer.name} tersisa 1 kartu tetapi belum menekan tombol UNO!`);
      }
    }

    // Terapkan efek kartu aksi
    let skipped = false;
    if (card.value === 'reverse') {
      this.direction *= -1;
      this.addLog(`🔄 Arah putaran permainan dibalik!`);
      if (this.players.length === 2) {
        skipped = true;
      }
    } else if (card.value === 'skip') {
      skipped = true;
    } else if (card.value === 'draw2') {
      const nextIdx = (this.currentTurnIndex + this.direction + this.players.length) % this.players.length;
      const victim = this.players[nextIdx];
      this.giveCards(victim, 2);
      this.addLog(`💥 ${victim.name} kena serangan Draw Two (+2) dan harus mengambil 2 kartu!`);
      skipped = true;
    } else if (card.value === 'wild4') {
      const nextIdx = (this.currentTurnIndex + this.direction + this.players.length) % this.players.length;
      const victim = this.players[nextIdx];
      this.giveCards(victim, 4);
      this.addLog(`💣 ${victim.name} kena serangan Wild Draw Four (+4) dan harus mengambil 4 kartu!`);
      skipped = true;
    }

    // Pindah giliran
    this.advanceTurn();
    if (skipped) {
      this.addLog(`⏭️ Giliran ${this.getCurrentPlayer().name} terlewati.`);
      this.advanceTurn();
    }

    this.addLog(`👉 Giliran selanjutnya: ${this.getCurrentPlayer().name}`);
    this.broadcast();
    return { success: true, won: false };
  }

  sayUno(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'Pemain tidak ditemukan.' };

    if (player.hand.length <= 2) {
      player.saidUno = true;
      this.addLog(`📢 ${player.name} berteriak: "UNO!!!" 🎴`);
      this.broadcast();
      return { success: true };
    } else {
      return { success: false, error: 'Kamu hanya bisa teriak UNO jika kartu di tangan tinggal 1 atau 2!' };
    }
  }

  catchUno(accuserPlayerId, targetPlayerId) {
    const accuser = this.players.find(p => p.id === accuserPlayerId);
    const target = this.players.find(p => p.id === targetPlayerId);
    if (!target) return { success: false, error: 'Target tidak ditemukan.' };

    if (target.hand.length === 1 && !target.saidUno) {
      this.giveCards(target, 2);
      this.addLog(`🚨 ${accuser ? accuser.name : 'Seseorang'} menangkap basah ${target.name} tidak teriak UNO! ${target.name} kena penalti ambil 2 kartu!`);
      this.broadcast();
      return { success: true, caught: true };
    } else {
      return { success: false, error: `${target.name} sudah teriak UNO atau kartunya lebih dari 1!` };
    }
  }

  giveCards(player, count) {
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) this.reshuffleDiscardIntoDeck();
      if (this.deck.length > 0) {
        player.hand.push(this.deck.pop());
      }
    }
  }

  reshuffleDiscardIntoDeck() {
    if (this.discardPile.length <= 1) return;
    const top = this.discardPile.pop();
    this.deck = shuffle(this.discardPile);
    this.discardPile = [top];
    this.addLog(`♻️ Dek diacak kembali dari tumpukan kartu buangan.`);
  }

  addLog(msg) {
    const timestamp = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.logs.unshift(`[${timestamp}] ${msg}`);
    if (this.logs.length > 30) this.logs.pop();
  }

  cardToString(card) {
    const colorEmoji = { red: '🟥', blue: '🟦', green: '🟩', yellow: '🟨', wild: '🌈' }[card.color] || '🎴';
    const valText = {
      skip: 'Skip',
      reverse: 'Reverse',
      draw2: '+2',
      wild: 'Wild',
      wild4: 'Wild +4'
    }[card.value] || card.value;
    return `${colorEmoji} ${valText}`;
  }

  colorName(color) {
    const names = { red: 'Merah 🔴', blue: 'Biru 🔵', green: 'Hijau 🟢', yellow: 'Kuning 🟡', wild: 'Bebas 🌈' };
    return names[color] || color;
  }

  subscribe(res) {
    this.subscribers.add(res);
  }

  unsubscribe(res) {
    this.subscribers.delete(res);
  }

  broadcast() {
    for (const res of this.subscribers) {
      try {
        const userId = res.unoUserId;
        const state = this.getPublicState(userId);
        res.write(`data: ${JSON.stringify(state)}\n\n`);
      } catch (_) {}
    }
  }

  getPublicState(forUserId) {
    return {
      roomId: this.roomId,
      hostId: this.hostId,
      status: this.status,
      maxPlayers: this.maxPlayers,
      direction: this.direction,
      currentColor: this.currentColor,
      currentValue: this.currentValue,
      topCard: this.discardPile.length > 0 ? this.discardPile[this.discardPile.length - 1] : null,
      deckCount: this.deck.length,
      currentTurnIndex: this.currentTurnIndex,
      activePlayer: this.getCurrentPlayer() ? {
        id: this.getCurrentPlayer().id,
        name: this.getCurrentPlayer().name
      } : null,
      turnExpiresAt: this.turnExpiresAt,
      players: this.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        cardCount: p.hand.length,
        saidUno: p.saidUno,
        isCurrent: idx === this.currentTurnIndex,
        isMe: p.id === forUserId
      })),
      myHand: (this.players.find(p => p.id === forUserId) || {}).hand || [],
      logs: this.logs.slice(0, 15),
      winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null
    };
  }
}

class UnoManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreateRoom(roomId, hostId, hostName, hostAvatar) {
    let room = this.rooms.get(roomId);
    if (!room || room.status === 'finished') {
      room = new UnoRoom(roomId, hostId, hostName, hostAvatar);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  findRoomByPlayer(userId) {
    for (const room of this.rooms.values()) {
      if (room.players.some(p => p.id === userId)) {
        return room;
      }
    }
    return null;
  }

  deleteRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.clearTurnTimer();
      this.rooms.delete(roomId);
    }
  }
}

const unoManager = new UnoManager();
module.exports = unoManager;
