const fs = require('fs');
const path = require('path');
const economyManager = require('./economy-manager');

const DUNGEON_FILE = path.join(__dirname, '..', 'data', 'dungeon.json');

const MONSTERS = [
  { name: 'Kelelawar Bayangan', emoji: '🦇', baseHp: 16, baseAtk: 4 },
  { name: 'Slime Gua Beracun', emoji: '🟢', baseHp: 22, baseAtk: 5 },
  { name: 'Kerangka Prajurit', emoji: '💀', baseHp: 28, baseAtk: 7 },
  { name: 'Goblin Pencuri', emoji: '👺', baseHp: 32, baseAtk: 8 },
  { name: 'Golem Batu Raksasa', emoji: '🗿', baseHp: 45, baseAtk: 10 },
  { name: 'Ksatria Kegelapan', emoji: '🤺', baseHp: 55, baseAtk: 13 },
  { name: 'Naga Purba Gua', emoji: '🐉', baseHp: 80, baseAtk: 16 }
];

function loadData() {
  try {
    if (fs.existsSync(DUNGEON_FILE)) {
      return JSON.parse(fs.readFileSync(DUNGEON_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Gagal membaca data dungeon:', err.message);
  }
  return {};
}

function saveData(data) {
  try {
    const dir = path.dirname(DUNGEON_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DUNGEON_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Gagal menyimpan data dungeon:', err.message);
  }
}

function getUserDungeon(userId) {
  const all = loadData();
  if (!all[userId]) {
    all[userId] = {
      level: 1,
      xp: 0,
      hp: 35,
      maxHp: 35,
      floor: 1,
      encounter: null,
      lastLog: 'Kamu bersiap di depan gerbang dungeon bawah tanah.',
      equippedWeapon: null,
      equippedArmor: null,
      equippedPet: null,
      stats: {
        monstersSlain: 0,
        highestFloor: 1,
        coinsEarned: 0
      }
    };
    saveData(all);
  }

  // Sinkronisasi otomatis perlengkapan jika player memiliki item di inventori
  try {
    const userEco = economyManager.getUser(userId);
    const inv = userEco.inventory || {};
    if (!all[userId].equippedWeapon && inv.iron_sword > 0) all[userId].equippedWeapon = 'iron_sword';
    if (!all[userId].equippedArmor && inv.moon_armor > 0) all[userId].equippedArmor = 'moon_armor';
    if (!all[userId].equippedPet && inv.cave_fox > 0) all[userId].equippedPet = 'cave_fox';
  } catch (_) {}

  return all[userId];
}

function updateUserData(userId, updater) {
  const all = loadData();
  const current = all[userId] || getUserDungeon(userId);
  const updated = updater(current);
  all[userId] = updated;
  saveData(all);
  return updated;
}

function getMonsterForFloor(floor) {
  const index = Math.min(MONSTERS.length - 1, Math.floor((floor - 1) / 3));
  const m = MONSTERS[index];
  const hpBonus = Math.floor((floor - 1) * 3.5);
  const atkBonus = Math.floor((floor - 1) * 0.8);
  const maxHp = m.baseHp + hpBonus;
  return {
    name: m.name,
    emoji: m.emoji,
    hp: maxHp,
    maxHp: maxHp,
    attack: m.baseAtk + atkBonus
  };
}

function explore(userId) {
  return updateUserData(userId, (st) => {
    if (st.encounter && st.encounter.hp > 0) {
      throw new Error(`Kalahkan ${st.encounter.name} terlebih dahulu sebelum maju!`);
    }

    const roll = Math.random();
    if (roll < 0.15) {
      const bonusCoins = Math.floor(40 + (st.floor * 15) + (Math.random() * 30));
      let petBonus = 0;
      if (st.equippedPet === 'cave_fox') {
        petBonus = Math.floor(bonusCoins * 0.35);
      }
      const totalCoins = bonusCoins + petBonus;
      economyManager.addWallet(userId, totalCoins);

      st.stats.coinsEarned = (st.stats.coinsEarned || 0) + totalCoins;
      st.encounter = null;
      st.lastLog = `🎁 Kamu menemukan Peti Harta Karun di lantai ${st.floor}! Mendapatkan +${totalCoins} Koin!`;
      return st;
    }

    const enemy = getMonsterForFloor(st.floor);
    st.encounter = enemy;
    st.lastLog = `Di lantai ${st.floor}, ${enemy.emoji} **${enemy.name}** menghadang jalanmu!`;
    return st;
  });
}

function attack(userId) {
  return updateUserData(userId, (st) => {
    if (!st.encounter || st.encounter.hp <= 0) {
      throw new Error('Tidak ada musuh yang dihadapi. Jelajahi dungeon dahulu!');
    }

    let weaponBonus = 0;
    if (st.equippedWeapon === 'iron_sword') weaponBonus = 12;
    const baseDmg = 7 + (st.level * 3) + weaponBonus;
    const playerDmg = baseDmg + Math.floor(Math.random() * 6);

    st.encounter.hp = Math.max(0, st.encounter.hp - playerDmg);

    if (st.encounter.hp <= 0) {
      const xpReward = 25 + (st.floor * 8);
      let coinReward = Math.floor(25 + (st.floor * 8) + (Math.random() * 20));
      if (st.equippedPet === 'cave_fox') {
        coinReward = Math.floor(coinReward * 1.35);
      }

      economyManager.addWallet(userId, coinReward);
      st.stats.monstersSlain = (st.stats.monstersSlain || 0) + 1;
      st.stats.coinsEarned = (st.stats.coinsEarned || 0) + coinReward;

      st.xp += xpReward;
      const monsterName = st.encounter.name;
      st.encounter = null;
      st.floor += 1;
      if (st.floor > (st.stats.highestFloor || 1)) {
        st.stats.highestFloor = st.floor;
      }

      let leveledUp = false;
      const neededXp = st.level * 100;
      if (st.xp >= neededXp) {
        st.xp -= neededXp;
        st.level += 1;
        st.maxHp += 10;
        st.hp = st.maxHp;
        leveledUp = true;
      }

      st.lastLog = `⚔️ ${monsterName} tumbang! +${xpReward} XP & +${coinReward} Koin.${leveledUp ? ` ⭐ LEVEL UP! Kamu sekarang Level ${st.level}!` : ''} Jalan ke lantai ${st.floor} terbuka!`;
      return st;
    }

    let armorDef = 0;
    if (st.equippedArmor === 'moon_armor') armorDef = 6;
    const enemyDmg = Math.max(2, st.encounter.attack - armorDef);
    st.hp -= enemyDmg;

    if (st.hp <= 0) {
      st.hp = Math.floor(st.maxHp * 0.7);
      st.floor = Math.max(1, st.floor - 1);
      const enemyName = st.encounter.name;
      st.encounter = null;
      st.lastLog = `💀 Kamu kalah diserang ${enemyName}! Mundur ke lantai ${st.floor} untuk memulihkan diri.`;
      return st;
    }

    st.lastLog = `🗡️ Kamu menyerang ${st.encounter.name} sebesar **${playerDmg} DMG**! ${st.encounter.name} membalas **${enemyDmg} DMG** (Sisa HP: ${st.hp}/${st.maxHp}).`;
    return st;
  });
}

function heal(userId) {
  return updateUserData(userId, (st) => {
    const userEco = economyManager.getUser(userId);
    const inv = userEco.inventory || {};

    if (inv.healing_potion && inv.healing_potion > 0) {
      inv.healing_potion -= 1;
      const healAmount = 35;
      st.hp = Math.min(st.maxHp, st.hp + healAmount);
      st.lastLog = `🧪 Kamu meminum Ramuan Pemulih! HP pulih +${healAmount} (HP sekarang: ${st.hp}/${st.maxHp}, sisa ramuan: ${inv.healing_potion}).`;
      return st;
    }

    if (!st.encounter) {
      st.hp = st.maxHp;
      st.lastLog = '⛺ Kamu beristirahat di dekat api unggun lorong. HP pulih sepenuhnya!';
      return st;
    }

    throw new Error('Kamu tidak memiliki Ramuan Pemulih (beli di Toko)! Tidak bisa istirahat saat ada musuh.');
  });
}

function retreat(userId) {
  return updateUserData(userId, (st) => {
    if (!st.encounter) {
      throw new Error('Tidak ada musuh untuk dihindari.');
    }
    const enemyName = st.encounter.name;
    st.encounter = null;
    st.lastLog = `💨 Kamu berhasil kabur dari ${enemyName} kembali ke koridor aman.`;
    return st;
  });
}

function equip(userId, itemId) {
  return updateUserData(userId, (st) => {
    const userEco = economyManager.getUser(userId);
    const inv = userEco.inventory || {};
    if (!inv[itemId] || inv[itemId] <= 0) {
      throw new Error('Kamu belum memiliki item ini di inventori tokomu.');
    }

    if (itemId === 'iron_sword') {
      st.equippedWeapon = itemId;
      st.lastLog = '🗡️ Pedang Penjelajah berhasil dipasang! Attack bertambah +12.';
    } else if (itemId === 'moon_armor') {
      st.equippedArmor = itemId;
      st.lastLog = '🛡️ Zirah Bulan berhasil dipasang! Pertahanan bertambah (-6 DMG dari monster).';
    } else if (itemId === 'cave_fox') {
      st.equippedPet = itemId;
      st.lastLog = '🦊 Rubah Gua Mistis diaktifkan! Koin dan loot dungeon mendapat bonus +35%.';
    } else {
      throw new Error('Item ini tidak bisa dipasang sebagai perlengkapan pertarungan.');
    }
    return st;
  });
}

module.exports = {
  getUserDungeon,
  explore,
  attack,
  heal,
  retreat,
  equip
};
