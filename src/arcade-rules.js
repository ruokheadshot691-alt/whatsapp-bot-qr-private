/**
 * TuffBot Arcade & Casino Rules Module
 * Mendukung fitur .slot, .gacha, .balance, dan .start
 */

const symbols = [
  { id: 'seven', label: '7', glyph: '7', payout: 25 },
  { id: 'diamond', label: '◆', glyph: '◆', payout: 15 },
  { id: 'bar', label: 'BAR', glyph: '▰', payout: 10 },
  { id: 'bell', label: 'BELL', glyph: '🔔', payout: 8 },
  { id: 'cherry', label: 'CHERRY', glyph: '🍒', payout: 6 },
  { id: 'lemon', label: 'LEMON', glyph: '🍋', payout: 4 }
];

const rewardsPool = [
  { name: "Golden Jackpot Trophy", rarity: "SSR", value: 1200 },
  { name: "Ruby King Crown", rarity: "SSR", value: 1000 },
  { name: "Lucky Neon Star", rarity: "SR", value: 500 },
  { name: "Cherry Charm Ring", rarity: "SR", value: 350 },
  { name: "Pocket Arcade Bell", rarity: "R", value: 180 },
  { name: "Retro Pixel Token", rarity: "R", value: 120 }
];

function spinSlot(wager = 100) {
  const r1 = symbols[Math.floor(Math.random() * symbols.length)];
  const r2 = symbols[Math.floor(Math.random() * symbols.length)];
  const r3 = symbols[Math.floor(Math.random() * symbols.length)];

  let win = 0;
  let isJackpot = false;

  if (r1.id === r2.id && r2.id === r3.id) {
    win = wager * r1.payout;
    isJackpot = true;
  } else if (r1.id === r2.id || r2.id === r3.id || r1.id === r3.id) {
    win = Math.floor(wager * 1.5);
  }

  return {
    reels: [r1, r2, r3],
    display: `[ ${r1.glyph} | ${r2.glyph} | ${r3.glyph} ]`,
    wager,
    win,
    isJackpot
  };
}

function rollGacha(times = 1) {
  const items = [];
  for (let i = 0; i < times; i++) {
    const roll = Math.random() * 100;
    let rarity = "R";
    if (roll < 3) rarity = "SSR";
    else if (roll < 18) rarity = "SR";

    const pool = rewardsPool.filter(r => r.rarity === rarity);
    const item = pool[Math.floor(Math.random() * pool.length)];
    items.push(item);
  }
  return items;
}

module.exports = {
  symbols,
  rewardsPool,
  spinSlot,
  rollGacha
};
