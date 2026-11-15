const SYMBOLS = ['🍒', '🍋', '🍇', '🍉', '⭐', '💎', '7️⃣'];

function playSlot(betAmount) {
  const bet = Math.floor(betAmount);

  const r1 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  const r2 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  const r3 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];

  let multiplier = 0;
  let title = '';

  if (r1 === r2 && r2 === r3) {
    if (r1 === '7️⃣') {
      multiplier = 10;
      title = '🔥 JACKPOT BESAR 777! (10x)';
    } else if (r1 === '💎') {
      multiplier = 7;
      title = '💎 MEGA JACKPOT BERLIAN! (7x)';
    } else if (r1 === '⭐') {
      multiplier = 5;
      title = '⭐ BINTANG EMAS KEMBAR TIGA! (5x)';
    } else {
      multiplier = 3.5;
      title = '🎉 KOMBO BUAH KEMBAR TIGA! (3.5x)';
    }
  } else if (r1 === r2 || r2 === r3 || r1 === r3) {
    multiplier = 1.5;
    title = '✨ Lumayan! Dua simbol cocok (1.5x)';
  } else {
    multiplier = 0;
    title = '💀 Belum beruntung, coba putar lagi!';
  }

  const payout = Math.floor(bet * multiplier);
  const netProfit = payout - bet;

  return {
    reels: [r1, r2, r3],
    won: multiplier > 0,
    multiplier,
    payout,
    netProfit,
    title
  };
}

function playCoinflip(sideChoice, betAmount = 0) {
  const bet = Math.max(0, Math.floor(betAmount));
  const rawChoice = String(sideChoice || '').trim().toLowerCase();

  let choice = 'gambar';
  let mode = 'coin';

  if (['benar', 'bener', 'b', 'true'].includes(rawChoice)) {
    choice = 'benar';
    mode = 'truth';
  } else if (['salah', 's', 'false'].includes(rawChoice)) {
    choice = 'salah';
    mode = 'truth';
  } else if (['angka', 'a', 'tails', 'tail', 't'].includes(rawChoice)) {
    choice = 'angka';
    mode = 'coin';
  } else {
    choice = 'gambar';
    mode = 'coin';
  }

  const isHeadOrTrue = Math.random() < 0.5;
  const roll = mode === 'truth'
    ? (isHeadOrTrue ? 'benar' : 'salah')
    : (isHeadOrTrue ? 'gambar' : 'angka');

  const won = choice === roll;
  const payout = won && bet > 0 ? bet * 2 : 0;

  return {
    won,
    choice,
    roll,
    mode,
    payout,
    netProfit: won ? bet : -bet
  };
}

function playDice(betAmount) {
  const bet = Math.floor(betAmount);
  const playerRoll = Math.floor(Math.random() * 6) + 1;
  const botRoll = Math.floor(Math.random() * 6) + 1;

  if (playerRoll > botRoll) {
    return {
      result: 'win',
      playerRoll,
      botRoll,
      payout: bet * 2,
      netProfit: bet,
      desc: `Dadu kamu (**${playerRoll}**) mengalahkan dadu bot (**${botRoll}**)!`
    };
  } else if (playerRoll === botRoll) {
    return {
      result: 'draw',
      playerRoll,
      botRoll,
      payout: bet,
      netProfit: 0,
      desc: `Dadu kamu (**${playerRoll}**) sama dengan dadu bot (**${botRoll}**)! Taruhan dikembalikan.`
    };
  } else {
    return {
      result: 'lose',
      playerRoll,
      botRoll,
      payout: 0,
      netProfit: -bet,
      desc: `Dadu bot (**${botRoll}**) mengalahkan dadu kamu (**${playerRoll}**)!`
    };
  }
}

// === ROULETTE (ROLET KASINO) ===
const ROULETTE_RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

function playRoulette(choiceArg, betAmount) {
  const bet = Math.floor(betAmount);
  const rawChoice = String(choiceArg || '').trim().toLowerCase();

  const rollNumber = Math.floor(Math.random() * 37); // 0 - 36
  let rollColor = 'hitam';
  let rollEmoji = '⬛';

  if (rollNumber === 0) {
    rollColor = 'hijau';
    rollEmoji = '🟩';
  } else if (ROULETTE_RED.includes(rollNumber)) {
    rollColor = 'merah';
    rollEmoji = '🟥';
  }

  let won = false;
  let multiplier = 0;
  let choiceDesc = rawChoice;

  if (['merah', 'red', 'm'].includes(rawChoice)) {
    choiceDesc = '🟥 Merah';
    if (rollColor === 'merah') {
      won = true;
      multiplier = 2;
    }
  } else if (['hitam', 'black', 'h'].includes(rawChoice)) {
    choiceDesc = '⬛ Hitam';
    if (rollColor === 'hitam') {
      won = true;
      multiplier = 2;
    }
  } else if (['hijau', 'green', 'g'].includes(rawChoice)) {
    choiceDesc = '🟩 Hijau (0)';
    if (rollColor === 'hijau') {
      won = true;
      multiplier = 14;
    }
  } else if (['ganjil', 'odd'].includes(rawChoice)) {
    choiceDesc = 'Ganjil';
    if (rollNumber > 0 && rollNumber % 2 !== 0) {
      won = true;
      multiplier = 2;
    }
  } else if (['genap', 'even'].includes(rawChoice)) {
    choiceDesc = 'Genap';
    if (rollNumber > 0 && rollNumber % 2 === 0) {
      won = true;
      multiplier = 2;
    }
  } else if (/^\d+$/.test(rawChoice)) {
    const num = Number(rawChoice);
    if (num >= 0 && num <= 36) {
      choiceDesc = `Angka Tunggal ${num}`;
      if (rollNumber === num) {
        won = true;
        multiplier = 36;
      }
    }
  }

  const payout = won ? Math.floor(bet * multiplier) : 0;
  const netProfit = payout - bet;

  return {
    rollNumber,
    rollColor,
    rollEmoji,
    choiceDesc,
    won,
    multiplier,
    payout,
    netProfit
  };
}

// === BLACKJACK (21) ===
const CARD_SUITS = ['♠️', '♥️', '♦️', '♣️'];
const CARD_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function drawCard() {
  const rank = CARD_RANKS[Math.floor(Math.random() * CARD_RANKS.length)];
  const suit = CARD_SUITS[Math.floor(Math.random() * CARD_SUITS.length)];
  return { rank, suit, str: `${rank}${suit}` };
}

function calculateHandValue(cards) {
  let value = 0;
  let aces = 0;

  for (const card of cards) {
    if (['J', 'Q', 'K'].includes(card.rank)) {
      value += 10;
    } else if (card.rank === 'A') {
      aces += 1;
      value += 11;
    } else {
      value += Number(card.rank);
    }
  }

  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }

  return value;
}

function playBlackjack(betAmount) {
  const bet = Math.floor(betAmount);

  let playerCards = [drawCard(), drawCard()];
  let dealerCards = [drawCard(), drawCard()];

  let playerTotal = calculateHandValue(playerCards);
  let dealerTotal = calculateHandValue(dealerCards);

  // Natural Blackjack
  if (playerTotal === 21) {
    if (dealerTotal === 21) {
      return {
        playerCards,
        playerTotal,
        dealerCards,
        dealerTotal,
        result: 'draw',
        payout: bet,
        netProfit: 0,
        title: '🤝 Natural Blackjack Keduanya! Seri (Push), taruhan dikembalikan.'
      };
    }
    const payout = Math.floor(bet * 2.5);
    return {
      playerCards,
      playerTotal,
      dealerCards,
      dealerTotal,
      result: 'blackjack',
      payout,
      netProfit: payout - bet,
      title: '🔥 NATURAL BLACKJACK 21! Kemenangan Spektakuler (2.5x)!'
    };
  }

  // Tactical hit logic for player: if total < 16, take 1 hit
  if (playerTotal < 16) {
    const extra = drawCard();
    playerCards.push(extra);
    playerTotal = calculateHandValue(playerCards);
  }

  // If player busted
  if (playerTotal > 21) {
    return {
      playerCards,
      playerTotal,
      dealerCards,
      dealerTotal,
      result: 'lose',
      payout: 0,
      netProfit: -bet,
      title: `💥 BUST! Kartu kamu melebihi 21 (${playerTotal}). Dealer menang!`
    };
  }

  // Dealer draws until >= 17
  while (dealerTotal < 17) {
    const extra = drawCard();
    dealerCards.push(extra);
    dealerTotal = calculateHandValue(dealerCards);
  }

  // Evaluate final scores
  if (dealerTotal > 21) {
    return {
      playerCards,
      playerTotal,
      dealerCards,
      dealerTotal,
      result: 'win',
      payout: bet * 2,
      netProfit: bet,
      title: `🎉 Dealer BUST (${dealerTotal})! Kamu menang mutlak (2x)!`
    };
  } else if (playerTotal > dealerTotal) {
    return {
      playerCards,
      playerTotal,
      dealerCards,
      dealerTotal,
      result: 'win',
      payout: bet * 2,
      netProfit: bet,
      title: `🏆 Skor kamu (${playerTotal}) mengungguli Dealer (${dealerTotal})! Menang (2x)!`
    };
  } else if (playerTotal === dealerTotal) {
    return {
      playerCards,
      playerTotal,
      dealerCards,
      dealerTotal,
      result: 'draw',
      payout: bet,
      netProfit: 0,
      title: `🤝 Skor sama (${playerTotal} vs ${dealerTotal})! Seri, taruhan dikembalikan.`
    };
  } else {
    return {
      playerCards,
      playerTotal,
      dealerCards,
      dealerTotal,
      result: 'lose',
      payout: 0,
      netProfit: -bet,
      title: `💀 Dealer (${dealerTotal}) mengalahkan skormu (${playerTotal}). Kamu kalah!`
    };
  }
}

// === SUIT (BATU GUNTING KERTAS / RPS) ===
function playRPS(playerChoiceArg, betAmount = 0) {
  const bet = Math.max(0, Math.floor(betAmount));
  const raw = String(playerChoiceArg || '').trim().toLowerCase();

  let p = 'batu';
  let pEmoji = '🪨';
  if (['g', 'gunting', 'scissors'].includes(raw)) {
    p = 'gunting';
    pEmoji = '✂️';
  } else if (['k', 'kertas', 'paper'].includes(raw)) {
    p = 'kertas';
    pEmoji = '📄';
  }

  const choices = [
    { name: 'batu', emoji: '🪨' },
    { name: 'gunting', emoji: '✂️' },
    { name: 'kertas', emoji: '📄' }
  ];
  const botChoice = choices[Math.floor(Math.random() * choices.length)];

  let result = 'draw';
  if (p === botChoice.name) {
    result = 'draw';
  } else if (
    (p === 'batu' && botChoice.name === 'gunting') ||
    (p === 'gunting' && botChoice.name === 'kertas') ||
    (p === 'kertas' && botChoice.name === 'batu')
  ) {
    result = 'win';
  } else {
    result = 'lose';
  }

  const payout = result === 'win' ? bet * 2 : (result === 'draw' ? bet : 0);
  const netProfit = result === 'win' ? bet : (result === 'draw' ? 0 : -bet);

  return {
    playerPick: { name: p, emoji: pEmoji },
    botPick: botChoice,
    result,
    payout,
    netProfit
  };
}

// === PACUAN KUDA (HORSE RACE) ===
const HORSES = [
  { no: 1, name: 'Halilintar Cepat', emoji: '🐎' },
  { no: 2, name: 'Pegasus Emas', emoji: '🦄' },
  { no: 3, name: 'Kuda Hitam Perkasa', emoji: '🐴' },
  { no: 4, name: 'Zebra Kilat Samudra', emoji: '🦓' },
  { no: 5, name: 'Spirit Sang Juara', emoji: '🏇' }
];

function playHorseRace(chosenNo, betAmount) {
  const bet = Math.floor(betAmount);
  const choice = Number(chosenNo);

  const winnerIndex = Math.floor(Math.random() * HORSES.length);
  const winningHorse = HORSES[winnerIndex];
  const myHorse = HORSES.find(h => h.no === choice) || HORSES[0];

  const won = myHorse.no === winningHorse.no;
  const payout = won ? bet * 4 : 0;
  const netProfit = payout - bet;

  // Build race visual track
  const tracks = HORSES.map(h => {
    const isWinner = h.no === winningHorse.no;
    const progress = isWinner ? '🏁═══════════' : '═══' + '═'.repeat(Math.floor(Math.random() * 6)) + '🏃' + '═'.repeat(3);
    return `${h.no}. ${h.emoji} [${progress}] **${h.name}** ${isWinner ? '🏆 *FINISH 1st!*' : ''}`;
  });

  return {
    myHorse,
    winningHorse,
    tracksText: tracks.join('\n'),
    won,
    payout,
    netProfit
  };
}

// === MINES (TEBAK PETAK RANJAU) ===
function playMines(betAmount, mineCountArg = 3) {
  const bet = Math.floor(betAmount);
  const mineCount = Math.max(1, Math.min(5, Number(mineCountArg) || 3));

  // 9 tiles (3x3 grid)
  // Step simulation: 3 steps
  // Safe tiles total = 9 - mineCount
  const safeTilesCount = 9 - mineCount;
  const successChance = (safeTilesCount / 9) * ((safeTilesCount - 1) / 8) * ((safeTilesCount - 2) / 7);

  const survived = Math.random() < successChance;
  const multiplier = mineCount === 1 ? 1.4 : (mineCount === 2 ? 1.8 : (mineCount === 3 ? 2.5 : (mineCount === 4 ? 3.8 : 5.5)));

  let grid = [];
  let mineIndices = new Set();
  while (mineIndices.size < mineCount) {
    mineIndices.add(Math.floor(Math.random() * 9));
  }

  for (let i = 0; i < 9; i++) {
    if (mineIndices.has(i)) {
      grid.push('💣');
    } else {
      grid.push('💎');
    }
  }

  const gridDisplay = [
    `[ ${grid[0]} | ${grid[1]} | ${grid[2]} ]`,
    `[ ${grid[3]} | ${grid[4]} | ${grid[5]} ]`,
    `[ ${grid[6]} | ${grid[7]} | ${grid[8]} ]`
  ].join('\n');

  const payout = survived ? Math.floor(bet * multiplier) : 0;
  const netProfit = payout - bet;

  return {
    survived,
    multiplier,
    mineCount,
    gridDisplay,
    payout,
    netProfit
  };
}

// === KUIS MATEMATIKA CEPAT ===
function generateMathQuiz() {
  const operations = ['+', '-', '*'];
  const op = operations[Math.floor(Math.random() * operations.length)];

  let n1 = 0;
  let n2 = 0;
  let ans = 0;

  if (op === '+') {
    n1 = Math.floor(Math.random() * 90) + 10;
    n2 = Math.floor(Math.random() * 90) + 10;
    ans = n1 + n2;
  } else if (op === '-') {
    n1 = Math.floor(Math.random() * 90) + 20;
    n2 = Math.floor(Math.random() * (n1 - 10)) + 5;
    ans = n1 - n2;
  } else {
    n1 = Math.floor(Math.random() * 12) + 3;
    n2 = Math.floor(Math.random() * 12) + 2;
    ans = n1 * n2;
  }

  return {
    soal: `${n1} ${op === '*' ? '×' : op} ${n2}`,
    jawaban: String(ans),
    reward: Math.floor(Math.random() * 201) + 250 // 250 - 450 koin
  };
}

const SUSUN_KATA_BANK = [
  { kata: 'komputer', acak: 'T - R - P - M - O - U - K - E', hint: 'Alat elektronik pengolah data' },
  { kata: 'indonesia', acak: 'S - I - N - O - N - E - D - I - A', hint: 'Negara kepulauan terbesar di dunia' },
  { kata: 'discord', acak: 'C - S - D - O - R - I - D', hint: 'Aplikasi obrolan komunitas gamer' },
  { kata: 'keyboard', acak: 'B - D - O - R - A - Y - E - K', hint: 'Papan tombol untuk mengetik' },
  { kata: 'matahari', acak: 'H - T - M - R - A - A - A - I', hint: 'Pusat tata surya yang menyinari bumi' },
  { kata: 'pesawat', acak: 'S - W - A - T - A - E - P', hint: 'Kendaraan transportasi di udara' },
  { kata: 'kucing', acak: 'G - N - C - I - U - K', hint: 'Hewan berbulu yang suka mengeong' },
  { kata: 'pantai', acak: 'N - T - A - A - I - P', hint: 'Tepian laut dengan hamparan pasir' },
  { kata: 'sepatu', acak: 'T - P - E - U - A - S', hint: 'Alas kaki pelindung saat berjalan' },
  { kata: 'kamera', acak: 'R - E - A - M - A - K', hint: 'Alat untuk menangkap foto dan video' },
  { kata: 'headphone', acak: 'P - D - E - H - O - A - N - H - E', hint: 'Alat dengar musik yang dipasang di telinga' },
  { kata: 'jendela', acak: 'N - L - E - J - D - A - E', hint: 'Ventilasi kaca di dinding rumah' },
  { kata: 'restoran', acak: 'T - S - O - N - R - A - R - E', hint: 'Tempat makan dan nongkrong santai' },
  { kata: 'pelangi', acak: 'L - N - G - I - A - E - P', hint: 'Lengkungan aneka warna indah setelah hujan' },
  { kata: 'sepeda', acak: 'P - D - A - S - E - E', hint: 'Kendaraan roda dua yang digowes' }
];

function getRandomSusunKata() {
  const item = SUSUN_KATA_BANK[Math.floor(Math.random() * SUSUN_KATA_BANK.length)];
  return {
    kata: item.kata,
    acak: item.acak,
    hint: item.hint,
    reward: Math.floor(Math.random() * 201) + 250 // 250 - 450 koin
  };
}

module.exports = {
  playSlot,
  playCoinflip,
  playDice,
  playRoulette,
  playBlackjack,
  playRPS,
  playHorseRace,
  playMines,
  generateMathQuiz,
  getRandomSusunKata
};
