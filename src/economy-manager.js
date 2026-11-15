const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const ecoFile = path.join(dataDir, 'economy.json');
const lotteryFile = path.join(dataDir, 'lottery.json');

function loadData() {
  try {
    if (fs.existsSync(ecoFile)) {
      return JSON.parse(fs.readFileSync(ecoFile, 'utf8'));
    }
  } catch (err) {
    console.error('Error membaca economy.json:', err.message);
  }
  return {};
}

function saveData(data) {
  try {
    fs.writeFileSync(ecoFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error menyimpan economy.json:', err.message);
  }
}

function loadLottery() {
  try {
    if (fs.existsSync(lotteryFile)) {
      return JSON.parse(fs.readFileSync(lotteryFile, 'utf8'));
    }
  } catch (err) {
    console.error('Error membaca lottery.json:', err.message);
  }
  return { pool: 25000, tickets: {} };
}

function saveLottery(data) {
  try {
    fs.writeFileSync(lotteryFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error menyimpan lottery.json:', err.message);
  }
}

function getUser(userId) {
  const data = loadData();
  if (!data[userId]) {
    data[userId] = {
      wallet: 500,
      bank: 0,
      lastDaily: 0,
      dailyStreak: 0,
      lastWork: 0,
      lastRob: 0,
      lastCrime: 0,
      lastBeg: 0,
      lastFish: 0,
      lastMine: 0,
      inventory: {},
      title: null,
      customTitleAllowed: false,
      buffs: {
        shieldActive: false,
        luckyCharges: 0,
        workDoubler: 0,
        hasSafe: false
      }
    };
    saveData(data);
  }
  const u = data[userId];
  if (!u.inventory) u.inventory = {};
  if (typeof u.title === 'undefined') u.title = null;
  if (typeof u.customTitleAllowed === 'undefined') u.customTitleAllowed = false;
  if (typeof u.dailyStreak === 'undefined') u.dailyStreak = 0;
  if (!u.buffs) {
    u.buffs = { shieldActive: false, luckyCharges: 0, workDoubler: 0, hasSafe: false };
  } else {
    if (typeof u.buffs.shieldActive === 'undefined') u.buffs.shieldActive = false;
    if (typeof u.buffs.luckyCharges === 'undefined') u.buffs.luckyCharges = 0;
    if (typeof u.buffs.workDoubler === 'undefined') u.buffs.workDoubler = 0;
    if (typeof u.buffs.hasSafe === 'undefined') u.buffs.hasSafe = false;
  }
  return u;
}

function addWallet(userId, amount) {
  const data = loadData();
  if (!data[userId]) getUser(userId);
  const current = loadData();
  current[userId].wallet = Math.max(0, (current[userId].wallet || 0) + Math.floor(Number(amount)));
  saveData(current);
  return current[userId];
}

function removeWallet(userId, amount) {
  const data = loadData();
  if (!data[userId]) getUser(userId);
  const current = loadData();
  current[userId].wallet = Math.max(0, (current[userId].wallet || 0) - Math.floor(Number(amount)));
  saveData(current);
  return current[userId];
}

function deposit(userId, amountStr) {
  const user = getUser(userId);
  let amount = 0;
  if (amountStr === 'all' || amountStr === 'semua') {
    amount = user.wallet;
  } else {
    amount = /^\d+$/.test(String(amountStr)) ? Number(amountStr) : NaN;
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { success: false, error: 'Jumlah koin yang dideposit harus berupa angka valid di atas 0!' };
  }
  if (user.wallet < amount) {
    return { success: false, error: `Saldo dompetmu tidak cukup! Saldo dompet saat ini: **${formatCoin(user.wallet)}**.` };
  }

  const data = loadData();
  data[userId].wallet -= amount;
  data[userId].bank = (data[userId].bank || 0) + amount;
  saveData(data);
  return { success: true, deposited: amount, wallet: data[userId].wallet, bank: data[userId].bank };
}

function withdraw(userId, amountStr) {
  const user = getUser(userId);
  let amount = 0;
  if (amountStr === 'all' || amountStr === 'semua') {
    amount = user.bank;
  } else {
    amount = /^\d+$/.test(String(amountStr)) ? Number(amountStr) : NaN;
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { success: false, error: 'Jumlah koin yang ditarik harus berupa angka valid di atas 0!' };
  }
  if (user.bank < amount) {
    return { success: false, error: `Saldo bankmu tidak cukup! Saldo di bank saat ini: **${formatCoin(user.bank)}**.` };
  }

  const data = loadData();
  data[userId].bank -= amount;
  data[userId].wallet = (data[userId].wallet || 0) + amount;
  saveData(data);
  return { success: true, withdrawn: amount, wallet: data[userId].wallet, bank: data[userId].bank };
}

function transfer(fromId, toId, amount) {
  if (fromId === toId) {
    return { success: false, error: 'Kamu tidak bisa mentransfer koin ke dirimu sendiri!' };
  }
  const fromUser = getUser(fromId);
  const amt = /^\d+$/.test(String(amount)) ? Number(amount) : NaN;

  if (!Number.isSafeInteger(amt) || amt <= 0) {
    return { success: false, error: 'Jumlah koin yang ditransfer harus angka positif!' };
  }
  if (fromUser.wallet < amt) {
    return { success: false, error: `Saldo dompetmu tidak cukup! Saldo dompet: **${formatCoin(fromUser.wallet)}**.` };
  }

  const data = loadData();
  data[fromId].wallet -= amt;
  if (!data[toId]) getUser(toId);
  const updated = loadData();
  updated[toId].wallet = (updated[toId].wallet || 0) + amt;
  saveData(updated);

  return { success: true, amount: amt, fromWallet: updated[fromId].wallet, toWallet: updated[toId].wallet };
}

function claimDaily(userId) {
  const user = getUser(userId);
  const now = Date.now();
  const cooldown = 24 * 60 * 60 * 1000; // 24 jam
  const streakWindow = 48 * 60 * 60 * 1000; // 48 jam untuk menjaga streak

  if (now - (user.lastDaily || 0) < cooldown) {
    const remaining = cooldown - (now - user.lastDaily);
    return { success: false, remainingMs: remaining };
  }

  // Hitung daily streak
  let newStreak = 1;
  if (user.lastDaily && (now - user.lastDaily) <= streakWindow) {
    newStreak = (user.dailyStreak || 0) + 1;
  }

  // Hadiah dasar 1.000 s/d 2.000 koin
  const baseReward = Math.floor(Math.random() * 1001) + 1000;
  // Bonus streak: +10% per hari streak (maks +70% di hari ke-7)
  const streakMultiplier = Math.min(0.7, (newStreak - 1) * 0.1);
  const streakBonus = Math.floor(baseReward * streakMultiplier);
  const totalReward = baseReward + streakBonus;

  const data = loadData();
  data[userId].wallet = (data[userId].wallet || 0) + totalReward;
  data[userId].lastDaily = now;
  data[userId].dailyStreak = newStreak;

  // Hadiah spesial kelipatan 7 hari: dapat Mystery Box gratis!
  let gotFreeBox = false;
  if (newStreak % 7 === 0) {
    data[userId].inventory = data[userId].inventory || {};
    data[userId].inventory.box = (data[userId].inventory.box || 0) + 1;
    gotFreeBox = true;
  }

  saveData(data);

  return {
    success: true,
    baseReward,
    streakBonus,
    totalReward,
    streak: newStreak,
    gotFreeBox,
    newWallet: data[userId].wallet
  };
}

const JOBS = [
  { job: 'Barista Kopi Kenangan', pay: [300, 700], desc: 'Membuat 45 gelas es kopi susu pandan' },
  { job: 'Kurir Paket Kilat', pay: [350, 750], desc: 'Mengantar 30 paket belanja online tanpa nyasar' },
  { job: 'Programmer Lembur', pay: [450, 900], desc: 'Memperbaiki 12 bug di server produksi sampai subuh' },
  { job: 'Pedagang Cilok Crispy', pay: [250, 600], desc: 'Jualan cilok bumbu kacang ludes diserbu anak sekolah' },
  { job: 'Tukang Servis HP', pay: [350, 800], desc: 'Ganti LCD dan bersihkan lubang charger pelanggan' },
  { job: 'Streamer Game Santai', pay: [400, 850], desc: 'Live streaming 3 jam dan dapat saweran dari penonton' },
  { job: 'Penulis Konten Kreatif', pay: [300, 650], desc: 'Bikin 5 utas viral di media sosial' },
  { job: 'Mekanik Bengkel Racing', pay: [400, 850], desc: 'Bore up motor bebek dan ganti knalpot brong' },
  { job: 'Pilot Drone Event', pay: [450, 950], desc: 'Mengambil video sinematik konser musik spektakuler' }
];

function workJob(userId) {
  const user = getUser(userId);
  const now = Date.now();
  const cooldown = 30 * 60 * 1000; // 30 menit cooldown

  if (now - (user.lastWork || 0) < cooldown) {
    const remaining = cooldown - (now - user.lastWork);
    return { success: false, remainingMs: remaining };
  }

  const jobObj = JOBS[Math.floor(Math.random() * JOBS.length)];
  let salary = Math.floor(Math.random() * (jobObj.pay[1] - jobObj.pay[0] + 1)) + jobObj.pay[0];

  let doubled = false;
  let remainingCharges = 0;
  const data = loadData();

  // Cek apakah punya buff Elixir Pengganda Koin
  if (data[userId].buffs && data[userId].buffs.workDoubler > 0) {
    salary *= 2;
    data[userId].buffs.workDoubler -= 1;
    doubled = true;
    remainingCharges = data[userId].buffs.workDoubler;
  }

  data[userId].wallet = (data[userId].wallet || 0) + salary;
  data[userId].lastWork = now;
  saveData(data);

  return {
    success: true,
    job: jobObj.job,
    desc: jobObj.desc,
    salary,
    doubled,
    remainingCharges,
    newWallet: data[userId].wallet
  };
}

const CRIMES = [
  { action: 'Membobol Brankas Mini Market', loot: [1500, 2800], failDesc: 'Alarm berbunyi dan polisi mengepung toko!' },
  { action: 'Meretas Rekening Kripto Ilegal', loot: [2000, 3600], failDesc: 'IP terdeteksi cyber crime dan rekeningmu dibekukan!' },
  { action: 'Menyelundupkan Mobil Antik Langka', loot: [1800, 3200], failDesc: 'Patroli jalan tol mencegat konvoi mobil!' },
  { action: 'Mencuri Koleksi Berlian Museum', loot: [2200, 3900], failDesc: 'Tersengat sensor laser pengaman kaca!' },
  { action: 'Menjual Kode Rahasia Perusahaan Jahat', loot: [1600, 3000], failDesc: 'Agen intelijen menyergap tempat pertemuan!' }
];

function crimeJob(userId) {
  const user = getUser(userId);
  const now = Date.now();
  const cooldown = 40 * 60 * 1000; // 40 menit

  if (now - (user.lastCrime || 0) < cooldown) {
    return { success: false, onCooldown: true, remainingMs: cooldown - (now - user.lastCrime) };
  }

  const data = loadData();
  data[userId].lastCrime = now;

  const crimeObj = CRIMES[Math.floor(Math.random() * CRIMES.length)];
  const isSuccess = Math.random() < 0.48;

  if (isSuccess) {
    const loot = Math.floor(Math.random() * (crimeObj.loot[1] - crimeObj.loot[0] + 1)) + crimeObj.loot[0];
    data[userId].wallet = (data[userId].wallet || 0) + loot;
    saveData(data);
    return {
      success: true,
      action: crimeObj.action,
      loot,
      newWallet: data[userId].wallet
    };
  } else {
    const fine = Math.min(data[userId].wallet, Math.floor(Math.random() * 701) + 500);
    data[userId].wallet = Math.max(0, (data[userId].wallet || 0) - fine);
    saveData(data);
    return {
      success: false,
      caught: true,
      action: crimeObj.action,
      failDesc: crimeObj.failDesc,
      fine,
      newWallet: data[userId].wallet
    };
  }
}

const BEG_RESPONSES = [
  'Orang lewat merasa iba dan memberimu uang jajan.',
  'Seorang bapak dermawan melempar recehan dari mobil mewahnya.',
  'Kakak baik hati membelikanmu roti dan memberi sisa uang kembalian.',
  'Anak sultan salah pencet transfer koin ke dompetmu!',
  'Nenek ramah tersenyum dan memberimu uang saku tambahan.'
];

const BEG_FAILS = [
  'Kamu diusir oleh satpam karena nongkrong di depan lobi mall.',
  'Orang-orang lewat cuma melirik sinis dan pura-pura main HP.',
  'Alih-alih uang, seseorang cuma memberimu bungkus permen kosong.',
  'Hujan deras turun, kamu harus berteduh tanpa dapat sepeser koin pun.'
];

function begCoin(userId) {
  const user = getUser(userId);
  const now = Date.now();
  const cooldown = 5 * 60 * 1000; // 5 menit

  if (now - (user.lastBeg || 0) < cooldown) {
    return { success: false, onCooldown: true, remainingMs: cooldown - (now - user.lastBeg) };
  }

  const data = loadData();
  data[userId].lastBeg = now;

  if (Math.random() < 0.8) {
    const coin = Math.floor(Math.random() * 251) + 50; // 50 - 300 koin
    data[userId].wallet = (data[userId].wallet || 0) + coin;
    saveData(data);
    const msg = BEG_RESPONSES[Math.floor(Math.random() * BEG_RESPONSES.length)];
    return { success: true, coin, text: msg, newWallet: data[userId].wallet };
  } else {
    saveData(data);
    const msg = BEG_FAILS[Math.floor(Math.random() * BEG_FAILS.length)];
    return { success: false, text: msg, newWallet: data[userId].wallet };
  }
}

// === SISTEM MEMANCING (FISHING) ===
const FISH_TABLE = [
  { id: 'sampah', name: 'Sepatu Butut / Kaleng', emoji: '👟', value: 25, weight: 20 },
  { id: 'ikan_teri', name: 'Ikan Teri Gurih', emoji: '🐟', value: 75, weight: 35 },
  { id: 'ikan_lele', name: 'Ikan Lele Rawa', emoji: '🐡', value: 200, weight: 25 },
  { id: 'ikan_salmon', name: 'Ikan Salmon Segar', emoji: '🍣', value: 500, weight: 12 },
  { id: 'ikan_hiu', name: 'Hiu Samudra Ganas', emoji: '🦈', value: 1600, weight: 6 },
  { id: 'harta_karun', name: 'Peti Harta Karun Samudra', emoji: '👑', value: 3800, weight: 2 }
];

function fishAction(userId) {
  const user = getUser(userId);
  const now = Date.now();
  const cooldown = 7 * 60 * 1000; // 7 menit

  if (now - (user.lastFish || 0) < cooldown) {
    return { success: false, onCooldown: true, remainingMs: cooldown - (now - user.lastFish) };
  }

  const data = loadData();
  data[userId].lastFish = now;

  let hasBait = false;
  if (data[userId].inventory && data[userId].inventory.umpan > 0) {
    data[userId].inventory.umpan -= 1;
    hasBait = true;
  }

  let pool = [];
  FISH_TABLE.forEach(f => {
    let w = f.weight;
    if (hasBait) {
      if (f.id === 'sampah') w = Math.max(2, Math.floor(w / 3));
      if (['ikan_salmon', 'ikan_hiu', 'harta_karun'].includes(f.id)) w *= 3;
    }
    for (let i = 0; i < w; i++) pool.push(f);
  });

  const caught = pool[Math.floor(Math.random() * pool.length)];

  data[userId].inventory = data[userId].inventory || {};
  data[userId].inventory[caught.id] = (data[userId].inventory[caught.id] || 0) + 1;
  saveData(data);

  return {
    success: true,
    catch: caught,
    hasBait,
    newCount: data[userId].inventory[caught.id]
  };
}

// === SISTEM MENAMBANG (MINING) ===
const MINE_TABLE = [
  { id: 'batu', name: 'Batu Kerikil Tambang', emoji: '🪨', value: 35, weight: 35 },
  { id: 'batubara', name: 'Batu Bara Hitam', emoji: '⚫', value: 180, weight: 30 },
  { id: 'besi', name: 'Bongkahan Besi Murni', emoji: '🔩', value: 450, weight: 18 },
  { id: 'emas', name: 'Bongkahan Emas Berkilau', emoji: '🪙', value: 1300, weight: 10 },
  { id: 'berlian', name: 'Berlian Biru Kristal', emoji: '💎', value: 3200, weight: 5 },
  { id: 'zamrud', name: 'Zamrud Hijau Langka', emoji: '❇️', value: 6500, weight: 2 }
];

function mineAction(userId) {
  const user = getUser(userId);
  const now = Date.now();
  const cooldown = 10 * 60 * 1000; // 10 menit

  if (now - (user.lastMine || 0) < cooldown) {
    return { success: false, onCooldown: true, remainingMs: cooldown - (now - user.lastMine) };
  }

  const data = loadData();
  data[userId].lastMine = now;

  let hasPickaxe = false;
  if (data[userId].inventory && data[userId].inventory.pickaxe > 0) {
    hasPickaxe = true;
  }

  let pool = [];
  MINE_TABLE.forEach(m => {
    let w = m.weight;
    if (hasPickaxe) {
      if (m.id === 'batu') w = Math.max(5, Math.floor(w / 2));
      if (['besi', 'emas', 'berlian', 'zamrud'].includes(m.id)) w *= 2.5;
    }
    for (let i = 0; i < w; i++) pool.push(m);
  });

  const mined = pool[Math.floor(Math.random() * pool.length)];
  const amount = hasPickaxe && Math.random() < 0.4 ? 2 : 1;

  data[userId].inventory = data[userId].inventory || {};
  data[userId].inventory[mined.id] = (data[userId].inventory[mined.id] || 0) + amount;
  saveData(data);

  return {
    success: true,
    ore: mined,
    amount,
    hasPickaxe,
    newCount: data[userId].inventory[mined.id]
  };
}

// === SISTEM JUAL BARANG (SELL) ===
const SELL_PRICES = {
  sampah: { name: 'Sepatu Butut / Kaleng', emoji: '👟', price: 25 },
  ikan_teri: { name: 'Ikan Teri Gurih', emoji: '🐟', price: 75 },
  ikan_lele: { name: 'Ikan Lele Rawa', emoji: '🐡', price: 200 },
  ikan_salmon: { name: 'Ikan Salmon Segar', emoji: '🍣', price: 500 },
  ikan_hiu: { name: 'Hiu Samudra Ganas', emoji: '🦈', price: 1600 },
  harta_karun: { name: 'Peti Harta Karun Samudra', emoji: '👑', price: 3800 },
  batu: { name: 'Batu Kerikil Tambang', emoji: '🪨', price: 35 },
  batubara: { name: 'Batu Bara Hitam', emoji: '⚫', price: 180 },
  besi: { name: 'Bongkahan Besi Murni', emoji: '🔩', price: 450 },
  emas: { name: 'Bongkahan Emas Berkilau', emoji: '🪙', price: 1300 },
  berlian: { name: 'Berlian Biru Kristal', emoji: '💎', price: 3200 },
  zamrud: { name: 'Zamrud Hijau Langka', emoji: '❇️', price: 6500 }
};

function sellItems(userId, queryArg) {
  const query = String(queryArg || '').trim().toLowerCase();
  const user = getUser(userId);
  const inv = user.inventory || {};

  const data = loadData();
  data[userId].inventory = data[userId].inventory || {};

  let totalGain = 0;
  const soldRecords = [];

  if (query === 'all' || query === 'semua' || !query) {
    for (const [id, info] of Object.entries(SELL_PRICES)) {
      const count = inv[id] || 0;
      if (count > 0) {
        const gain = count * info.price;
        totalGain += gain;
        soldRecords.push({ id, name: info.name, emoji: info.emoji, count, gain });
        delete data[userId].inventory[id];
      }
    }
  } else {
    const targetKey = Object.keys(SELL_PRICES).find(k => k === query || SELL_PRICES[k].name.toLowerCase().includes(query));
    if (!targetKey) {
      return {
        success: false,
        error: `Item **${query}** tidak bisa dijual atau bukan barang komoditas! Ketik \`.jual all\` untuk menjual semua hasil panen pancing/tambang.`
      };
    }
    const count = inv[targetKey] || 0;
    if (count <= 0) {
      return {
        success: false,
        error: `Kamu tidak memiliki **${SELL_PRICES[targetKey].emoji} ${SELL_PRICES[targetKey].name}** di dalam tas!`
      };
    }
    const info = SELL_PRICES[targetKey];
    totalGain = count * info.price;
    soldRecords.push({ id: targetKey, name: info.name, emoji: info.emoji, count, gain: totalGain });
    delete data[userId].inventory[targetKey];
  }

  if (soldRecords.length === 0) {
    return {
      success: false,
      error: 'Tasmu tidak memiliki hasil tangkapan pancing (.mancing) atau hasil tambang (.mining) untuk dijual!'
    };
  }

  data[userId].wallet = (data[userId].wallet || 0) + totalGain;
  saveData(data);

  return {
    success: true,
    soldRecords,
    totalGain,
    newWallet: data[userId].wallet
  };
}

function robUser(robberId, victimId) {
  if (robberId === victimId) {
    return { success: false, error: 'Kamu tidak bisa merampok dirimu sendiri!' };
  }
  const robber = getUser(robberId);
  const victim = getUser(victimId);
  const now = Date.now();
  const cooldown = 45 * 60 * 1000; // 45 menit cooldown

  if (now - (robber.lastRob || 0) < cooldown) {
    return { success: false, onCooldown: true, remainingMs: cooldown - (now - robber.lastRob) };
  }

  if (victim.wallet < 150) {
    return { success: false, error: 'Target terlalu miskin di dompetnya (di bawah 150 koin)! Koin di bank tidak bisa dirampok.' };
  }

  const data = loadData();
  data[robberId].lastRob = now;

  const victimData = data[victimId] || getUser(victimId);

  if (victimData.buffs && victimData.buffs.shieldActive) {
    victimData.buffs.shieldActive = false;
    saveData(data);
    return {
      success: false,
      shieldBlocked: true,
      error: '🛡️ **PERISAI AKTIF!** Target dilindungi oleh **Perisai Anti-Rampok**! Seranganmu terpental, perisai target pecah, dan semua koinnya aman!'
    };
  } else if (victimData.inventory && victimData.inventory.shield > 0) {
    victimData.inventory.shield = Math.max(0, victimData.inventory.shield - 1);
    saveData(data);
    return {
      success: false,
      shieldBlocked: true,
      error: '🛡️ **PERISAI AKTIF!** Target memiliki **Perisai Anti-Rampok** di tasnya! Perisai otomatis aktif menangkis seranganmu, koin target 100% aman!'
    };
  }

  const isSuccess = Math.random() < 0.42;

  if (isSuccess) {
    let stealableWallet = victim.wallet;
    let safeProtected = false;
    if ((victimData.buffs && victimData.buffs.hasSafe) || (victimData.inventory && victimData.inventory.brankas > 0)) {
      stealableWallet = Math.floor(victim.wallet * 0.4);
      safeProtected = true;
    }

    const percent = (Math.floor(Math.random() * 21) + 15) / 100;
    const stolen = Math.max(20, Math.floor(stealableWallet * percent));

    data[victimId].wallet = Math.max(0, data[victimId].wallet - stolen);
    data[robberId].wallet = (data[robberId].wallet || 0) + stolen;
    saveData(data);

    return {
      success: true,
      stolen,
      safeProtected,
      victimWallet: data[victimId].wallet,
      robberWallet: data[robberId].wallet
    };
  } else {
    const fine = Math.min(robber.wallet, Math.floor(Math.random() * 201) + 100);
    data[robberId].wallet = Math.max(0, data[robberId].wallet - fine);
    data[victimId].wallet = (data[victimId].wallet || 0) + fine;
    saveData(data);

    return { success: false, caught: true, fine, robberWallet: data[robberId].wallet };
  }
}

// === TOKO & PENUKARAN ITEM IN-GAME ===
const SHOP_ITEMS = [
  {
    id: 'shield',
    name: 'Perisai Anti-Rampok',
    emoji: '🛡️',
    price: 1500,
    desc: 'Melindungi dompet dari 1x serangan .rob. Koinmu aman dan perisai akan pecah menahan serangan.',
    type: 'buff'
  },
  {
    id: 'kopi',
    name: 'Kopi Energi',
    emoji: '⚡',
    price: 800,
    desc: 'Mereset cooldown kerja (.work) secara instan agar bisa langsung kerja lagi!',
    type: 'usable'
  },
  {
    id: 'box',
    name: 'Mystery Box',
    emoji: '🎁',
    price: 1200,
    desc: 'Buka kotak hadiah misteri: Koin melimpah (1.5k-3.5k), Jackpot (5k-10k), atau item langka!',
    type: 'usable'
  },
  {
    id: 'jimat',
    name: 'Jimat Keberuntungan',
    emoji: '🍀',
    price: 2500,
    desc: 'Memberikan berkah bonus kemenangan ekstra +25% di game taruhan (.slot, .dadu, .cf, .rolet) untuk 3x menang!',
    type: 'buff'
  },
  {
    id: 'umpan',
    name: 'Umpan Cacing Sakti',
    emoji: '🪱',
    price: 1000,
    desc: 'Umpan pancing khusus. Melipatgandakan peluang menangkap Salmon, Hiu, dan Harta Karun di .mancing!',
    type: 'usable'
  },
  {
    id: 'pickaxe',
    name: 'Beliung Tambang Besi',
    emoji: '⛏️',
    price: 3500,
    desc: 'Alat tambang kokoh. Memperbesar peluang menggali Emas, Berlian, dan Zamrud di .mining secara permanen di tas!',
    type: 'tool'
  },
  {
    id: 'brankas',
    name: 'Brankas Dompet Rahasia',
    emoji: '🔐',
    price: 6000,
    desc: 'Menjaga 60% isi koin dompetmu tetap aman dari perampok (.rob) meski perisaimu sudah habis!',
    type: 'buff'
  },
  {
    id: 'ramuan_kerja',
    name: 'Elixir Pekerja Keras',
    emoji: '🧪',
    price: 3000,
    desc: 'Menggandakan gaji kerja (.work) 2x lipat untuk 3x panggilan kerja berikutnya!',
    type: 'usable'
  },
  {
    id: 'tiket_lotre',
    name: 'Tiket Lotre Server',
    emoji: '🎟️',
    price: 500,
    desc: 'Tiket undian jackpot koin raksasa server! Cek akumulasi jackpot dengan .lotre.',
    type: 'usable'
  },
  {
    id: 'kado',
    name: 'Kotak Kado Kejutan',
    emoji: '🎀',
    price: 2000,
    desc: 'Kirim paket hadiah spesial berisi koin dan ucapan manis untuk teman di server (.gift @user).',
    type: 'usable'
  },
  {
    id: 'bom_jahil',
    name: 'Bom Tepung Jahil',
    emoji: '💣',
    price: 1000,
    desc: 'Jahili temanmu di chat dengan ledakan tepung berhamburan (.prank @user)!',
    type: 'usable'
  },
  {
    id: 'sultan',
    name: 'Gelar Sultan Server',
    emoji: '👑',
    price: 10000,
    desc: 'Gelar prestise permanen [👑 Sultan Server] yang dipasang di kartu profil (.bal).',
    type: 'title',
    titleText: '👑 Sultan Server'
  },
  {
    id: 'judi',
    name: 'Gelar Raja Judi',
    emoji: '🎲',
    price: 15000,
    desc: 'Gelar bergengsi [🎲 Raja Judi] untuk pejudi sejati, tampil di info dompet (.bal).',
    type: 'title',
    titleText: '🎲 Raja Judi'
  },
  {
    id: 'lord',
    name: 'Gelar Lord Tuff',
    emoji: '🔥',
    price: 25000,
    desc: 'Gelar kasta tertinggi [🔥 Lord Tuff] dengan wibawa tak tertandingi di server.',
    type: 'title',
    titleText: '🔥 Lord Tuff'
  },
  {
    id: 'konglomerat',
    name: 'Gelar Konglomerat',
    emoji: '💎',
    price: 50000,
    desc: 'Gelar legendaris [💎 Konglomerat Server] untuk konglomerat terkaya di server.',
    type: 'title',
    titleText: '💎 Konglomerat Server'
  },
  {
    id: 'custom_title',
    name: 'Tiket Gelar Kustom',
    emoji: '✨',
    price: 35000,
    desc: 'Kupon istimewa untuk membuat dan memasang gelar profil bebas sesukamu (.settitle <gelar>)!',
    type: 'usable'
  }
];

function getShopCatalog() {
  return SHOP_ITEMS;
}

function buyItem(userId, itemId) {
  const query = String(itemId || '').trim().toLowerCase();
  const item = SHOP_ITEMS.find(i => i.id === query || i.name.toLowerCase().includes(query));
  if (!item) {
    return { success: false, error: 'Item tidak ditemukan di katalog toko! Ketik `.shop` untuk melihat daftar barang yang bisa ditukar.' };
  }

  const user = getUser(userId);
  if (user.wallet < item.price) {
    return {
      success: false,
      error: `Koin dompetmu tidak cukup! Harga item **${item.emoji} ${item.name}** adalah **${formatCoin(item.price)}**, sedangkan saldo dompetmu saat ini: **${formatCoin(user.wallet)}**.`
    };
  }

  const data = loadData();
  data[userId].wallet = Math.max(0, (data[userId].wallet || 0) - item.price);
  if (!data[userId].inventory) data[userId].inventory = {};
  data[userId].inventory[item.id] = (data[userId].inventory[item.id] || 0) + 1;

  if (item.type === 'title') {
    data[userId].title = item.titleText;
  } else if (item.id === 'shield') {
    data[userId].buffs = data[userId].buffs || {};
    data[userId].buffs.shieldActive = true;
  } else if (item.id === 'jimat') {
    data[userId].buffs = data[userId].buffs || {};
    data[userId].buffs.luckyCharges = (data[userId].buffs.luckyCharges || 0) + 3;
  } else if (item.id === 'brankas') {
    data[userId].buffs = data[userId].buffs || {};
    data[userId].buffs.hasSafe = true;
  } else if (item.id === 'custom_title') {
    data[userId].customTitleAllowed = true;
  } else if (item.id === 'tiket_lotre') {
    const lottery = loadLottery();
    lottery.pool += Math.floor(item.price * 0.8);
    lottery.tickets[userId] = (lottery.tickets[userId] || 0) + 1;
    saveLottery(lottery);
  }

  saveData(data);
  return {
    success: true,
    item,
    newWallet: data[userId].wallet,
    titleEquipped: item.type === 'title' ? item.titleText : null
  };
}

function useItem(userId, itemId) {
  const query = String(itemId || '').trim().toLowerCase();
  const item = SHOP_ITEMS.find(i => i.id === query || i.name.toLowerCase().includes(query));
  const rawId = item ? item.id : query;

  const user = getUser(userId);
  const count = (user.inventory && user.inventory[rawId]) || 0;
  if (count <= 0) {
    return { success: false, error: `Kamu tidak memiliki item **${item ? item.name : rawId}** di tas! Ketik \`.inv\` untuk mengecek isi tas.` };
  }

  const data = loadData();
  data[userId].inventory[rawId] = Math.max(0, data[userId].inventory[rawId] - 1);
  let message = '';

  if (rawId === 'kopi') {
    data[userId].lastWork = 0;
    message = '⚡ Kamu meminum **Kopi Energi**! Cooldown kerja (.work) langsung direset seketika! Silakan ketik `.work` sekarang untuk mencari koin lagi.';
  } else if (rawId === 'box') {
    const roll = Math.random();
    if (roll < 0.40) {
      const reward = Math.floor(Math.random() * 2001) + 1500;
      data[userId].wallet = (data[userId].wallet || 0) + reward;
      message = `🎁 **MYSTERY BOX DIBUKA!** Selamat, kamu beruntung mendapatkan koin melimpah **+${formatCoin(reward)}**!`;
    } else if (roll < 0.55) {
      const reward = Math.floor(Math.random() * 5001) + 5000;
      data[userId].wallet = (data[userId].wallet || 0) + reward;
      message = `🔥 **JACKPOT BESAR DARI KOTAK MISTERI!!** Kamu mendapatkan hadiah koin sultan **+${formatCoin(reward)}**!`;
    } else if (roll < 0.80) {
      const prizes = ['shield', 'kopi', 'umpan', 'jimat'];
      const prizeId = prizes[Math.floor(Math.random() * prizes.length)];
      data[userId].inventory[prizeId] = (data[userId].inventory[prizeId] || 0) + 1;
      const pItem = SHOP_ITEMS.find(i => i.id === prizeId);
      message = `🎁 **MYSTERY BOX DIBUKA!** Kamu mendapatkan hadiah item gratis: **${pItem ? pItem.emoji + ' ' + pItem.name : prizeId}**!`;
    } else {
      const reward = Math.floor(Math.random() * 501) + 500;
      data[userId].wallet = (data[userId].wallet || 0) + reward;
      message = `📦 **MYSTERY BOX DIBUKA!** Kamu mendapatkan hadiah koin hiburan: **+${formatCoin(reward)}**.`;
    }
  } else if (rawId === 'shield') {
    data[userId].buffs = data[userId].buffs || {};
    data[userId].buffs.shieldActive = true;
    message = '🛡️ **Perisai Anti-Rampok Aktif!** Dompetmu kini terlindungi dari aksi .rob berikutnya.';
  } else if (rawId === 'jimat') {
    data[userId].buffs = data[userId].buffs || {};
    data[userId].buffs.luckyCharges = (data[userId].buffs.luckyCharges || 0) + 3;
    message = '🍀 **Jimat Keberuntungan Aktif!** Kamu mendapatkan bonus kemenangan ekstra +25% untuk 3x kemenangan taruhan berikutnya.';
  } else if (rawId === 'ramuan_kerja') {
    data[userId].buffs = data[userId].buffs || {};
    data[userId].buffs.workDoubler = (data[userId].buffs.workDoubler || 0) + 3;
    message = '🧪 **Elixir Pekerja Keras Aktif!** Gaji kerja kamu di `.work` akan dikalikan 2x lipat untuk 3x kerja berikutnya!';
  } else if (rawId === 'brankas') {
    data[userId].buffs = data[userId].buffs || {};
    data[userId].buffs.hasSafe = true;
    message = '🔐 **Brankas Rahasia Terpasang!** 60% koin di dompetmu kini aman dari aksi perampokan (.rob).';
  } else if (rawId === 'custom_title') {
    data[userId].customTitleAllowed = true;
    message = '✨ **Kupon Gelar Kustom Diaktifkan!** Gunakan perintah `.settitle <nama gelar>` untuk mengubah gelarmu sesuka hati!';
  } else if (['sultan', 'lord', 'judi', 'konglomerat'].includes(rawId)) {
    const tItem = SHOP_ITEMS.find(i => i.id === rawId);
    data[userId].title = tItem.titleText;
    message = `👑 Gelar **${tItem.titleText}** berhasil disematkan di profil kamu!`;
  } else {
    message = `Item ${rawId} berhasil digunakan.`;
  }

  saveData(data);
  return { success: true, message, newWallet: data[userId].wallet };
}

function setUserTitle(userId, title) {
  const data = loadData();
  getUser(userId);
  data[userId].title = title ? String(title).trim() : null;
  saveData(data);
  return data[userId].title;
}

function setCustomTitle(userId, titleText) {
  const clean = String(titleText || '').trim();
  if (!clean || clean.length > 32) {
    return { success: false, error: 'Gelar kustom harus memiliki panjang 1 hingga 32 karakter!' };
  }

  const user = getUser(userId);
  const data = loadData();

  if (!user.customTitleAllowed && (!user.inventory || !user.inventory.custom_title)) {
    return {
      success: false,
      error: 'Kamu belum memiliki izin gelar kustom! Beli item `Tiket Gelar Kustom` di `.shop` seharga 35.000 🪙 terlebih dahulu.'
    };
  }

  if (user.inventory && user.inventory.custom_title > 0) {
    data[userId].inventory.custom_title -= 1;
  }
  data[userId].title = `✨ ${clean}`;
  data[userId].customTitleAllowed = true;
  saveData(data);

  return { success: true, title: data[userId].title };
}

function checkAndConsumeLucky(userId) {
  const data = loadData();
  if (data[userId] && data[userId].buffs && data[userId].buffs.luckyCharges > 0) {
    data[userId].buffs.luckyCharges -= 1;
    const remaining = data[userId].buffs.luckyCharges;
    saveData(data);
    return { hasLucky: true, remaining };
  }
  return { hasLucky: false, remaining: 0 };
}

function getLotteryInfo() {
  const l = loadLottery();
  const totalTickets = Object.values(l.tickets || {}).reduce((a, b) => a + b, 0);
  return {
    pool: l.pool,
    totalTickets,
    ticketPrice: 500,
    tickets: l.tickets || {}
  };
}

function getLeaderboard(limit = 10) {
  const data = loadData();
  const list = [];
  for (const [id, val] of Object.entries(data)) {
    const total = (val.wallet || 0) + (val.bank || 0);
    list.push({ userId: id, wallet: val.wallet || 0, bank: val.bank || 0, total, title: val.title });
  }
  list.sort((a, b) => b.total - a.total);
  return list.slice(0, limit);
}

function formatCoin(num) {
  return Number(num || 0).toLocaleString('id-ID') + ' 🪙';
}

function formatTime(ms) {
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} jam`);
  if (minutes > 0) parts.push(`${minutes} menit`);
  if (parts.length === 0 || (hours === 0 && minutes < 2)) parts.push(`${seconds} detik`);
  return parts.join(' ');
}

module.exports = {
  getUser,
  addWallet,
  removeWallet,
  deposit,
  withdraw,
  transfer,
  claimDaily,
  workJob,
  crimeJob,
  begCoin,
  fishAction,
  mineAction,
  sellItems,
  robUser,
  getShopCatalog,
  buyItem,
  useItem,
  setCustomTitle,
  setUserTitle,
  checkAndConsumeLucky,
  getLotteryInfo,
  getLeaderboard,
  formatCoin,
  formatTime
};
