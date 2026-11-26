const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'GW_ADMIN_2026';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// 1. FIREBASE FIRESTORE INITIALIZATION
// ============================================================================
function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  let credentialObj = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credentialObj = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    credentialObj = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  } else {
    const localKeyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(localKeyPath)) {
      credentialObj = JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
    }
  }

  if (credentialObj) {
    admin.initializeApp({
      credential: admin.credential.cert(credentialObj)
    });
  } else {
    admin.initializeApp();
  }

  const firestore = admin.firestore();
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

const db = initFirebase();

// ============================================================================
// 2. CONSTANTS, COLLECTIONS & HELPER UTILITIES
// ============================================================================
const COL = {
  META: 'meta',
  USERS: 'users',
  PRODUCTS: 'products',
  ORDERS: 'orders',
  BILLS: 'bills',
  RECHARGES: 'recharges',
  WITHDRAWALS: 'withdrawals',
  TICKETS: 'tickets',
  BLOG: 'blogPosts',
  PROMOS: 'promos',
  NOTICES: 'notices',
  REFERRALS: 'referrals'
};

const VIP_TIERS = [
  { level: 0, req: 0 },
  { level: 1, req: 280 },
  { level: 2, req: 3800 },
  { level: 3, req: 8900 },
  { level: 4, req: 13000 },
  { level: 5, req: 50000 },
  { level: 6, req: 200000 },
  { level: 7, req: 500000 },
  { level: 8, req: 1000000 }
];

const COMMISSION_RATES = {
  level1: 0.60, // 60%
  level2: 0.04, // 4%
  level3: 0.01  // 1%
};

const DAILY_TASKS = [
  { id: 'daily_3', count: 3, reward: 120 },
  { id: 'daily_10', count: 10, reward: 600 },
  { id: 'daily_30', count: 30, reward: 2500 }
];

const CUMULATIVE_TASKS = [
  { id: 'cum_5', count: 5, reward: 150 },
  { id: 'cum_20', count: 20, reward: 1000 },
  { id: 'cum_50', count: 50, reward: 5000 }
];

const DEFAULT_CONFIG = {
  brandName: 'GROWTHWAVE CAPITAL',
  upiId: 'growthwave@upi',
  upiQr: '',
  minRecharge: 100,
  minWithdraw: 110,
  maxDailyWithdraw: 50000,
  checkinReward: 14,
  homeBanner: { image: '', text: 'Welcome to GrowthWave Capital — Earn Daily Passive Returns!' },
  popupBanner: { image: '', text: '' }
};

const DEFAULT_PRODUCTS = [
  {
    id: 'prod_starter_1',
    name: 'Starter Growth Fund',
    image: '',
    vipLevel: 0,
    price: 280,
    dailyIncome: 25,
    durationDays: 30,
    isLimited: false,
    remainingCopies: 0,
    totalCopies: 0,
    soldOut: false,
    soldOutMessage: 'Product khatam ho gaya hai koi or product buy karo thank you'
  },
  {
    id: 'prod_silver_2',
    name: 'Silver Wealth Plan',
    image: '',
    vipLevel: 1,
    price: 580,
    dailyIncome: 55,
    durationDays: 30,
    isLimited: false,
    remainingCopies: 0,
    totalCopies: 0,
    soldOut: false,
    soldOutMessage: 'Product khatam ho gaya hai koi or product buy karo thank you'
  },
  {
    id: 'prod_gold_3',
    name: 'Gold Multiplier Plan',
    image: '',
    vipLevel: 1,
    price: 1250,
    dailyIncome: 125,
    durationDays: 35,
    isLimited: false,
    remainingCopies: 0,
    totalCopies: 0,
    soldOut: false,
    soldOutMessage: 'Product khatam ho gaya hai koi or product buy karo thank you'
  },
  {
    id: 'prod_platinum_4',
    name: 'Platinum Capital Vault',
    image: '',
    vipLevel: 2,
    price: 3800,
    dailyIncome: 410,
    durationDays: 40,
    isLimited: true,
    remainingCopies: 50,
    totalCopies: 50,
    soldOut: false,
    soldOutMessage: 'Product khatam ho gaya hai koi or product buy karo thank you'
  }
];

function calcVipLevel(totalInvestment) {
  let lvl = 0;
  for (const tier of VIP_TIERS) {
    if (Number(totalInvestment || 0) >= tier.req) {
      lvl = tier.level;
    }
  }
  return lvl;
}

function round2(num) {
  return Math.round((Number(num || 0) + Number.EPSILON) * 100) / 100;
}

function todayKeyIST() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// Simple in-memory rate limiter for abuse protection
const rateBucket = new Map();
function rateLimit(maxHits = 80, windowMs = 60000) {
  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'global';
    const now = Date.now();
    const record = rateBucket.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }
    record.count += 1;
    rateBucket.set(key, record);
    if (record.count > maxHits) {
      return res.status(429).json({ success: false, message: 'Too many requests, please wait a moment.' });
    }
    next();
  };
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-key'] || req.query.adminKey || (req.body && req.body.adminKey);
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized admin access' });
  }
  next();
}

// ============================================================================
// 3. DATABASE HELPERS & SEEDING
// ============================================================================
async function seedInitialData() {
  const cfgRef = db.collection(COL.META).doc('config');
  const cfgSnap = await cfgRef.get();
  if (!cfgSnap.exists) {
    await cfgRef.set(DEFAULT_CONFIG);
  }

  const prodSnap = await db.collection(COL.PRODUCTS).limit(1).get();
  if (prodSnap.empty) {
    const batch = db.batch();
    for (const prod of DEFAULT_PRODUCTS) {
      batch.set(db.collection(COL.PRODUCTS).doc(prod.id), prod);
    }
    await batch.commit();
  }

  const promoRef = db.collection(COL.PROMOS).doc('GWBONUS100');
  const promoSnap = await promoRef.get();
  if (!promoSnap.exists) {
    await promoRef.set({
      code: 'GWBONUS100',
      reward: 100,
      maxUses: 10000,
      usedCount: 0,
      active: true,
      createdAt: new Date().toISOString()
    });
  }

  const noticeSnap = await db.collection(COL.NOTICES).limit(1).get();
  if (noticeSnap.empty) {
    await db.collection(COL.NOTICES).doc('notice_welcome').set({
      id: 'notice_welcome',
      icon: 'bell',
      title: 'Welcome to GrowthWave Capital',
      summary: 'Daily returns, instant referrals, and 24/7 support are active.',
      content: '<p>Start investing in verified plans to earn daily automated returns directly to your withdrawal wallet. Invite friends to earn up to 60% referral commission across 3 tiers.</p>',
      date: todayKeyIST(),
      createdAt: new Date().toISOString()
    });
  }
}

async function getConfig() {
  const snap = await db.collection(COL.META).doc('config').get();
  return snap.exists ? { ...DEFAULT_CONFIG, ...snap.data() } : { ...DEFAULT_CONFIG };
}

async function getAllProducts() {
  const snap = await db.collection(COL.PRODUCTS).get();
  return snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
}

async function getUserById(uid) {
  if (!uid) return null;
  const snap = await db.collection(COL.USERS).doc(String(uid)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getUserByPhone(phone) {
  const snap = await db.collection(COL.USERS).where('phone', '==', String(phone).trim()).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getUserByInviteCode(code) {
  if (!code || code === 'NONE') return null;
  const clean = String(code).trim().toUpperCase();
  const snap = await db.collection(COL.USERS).where('ownInviteCode', '==', clean).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function recordBill(userId, type, amountStr, status = 'Success', extra = {}) {
  const id = genId('BILL');
  const bill = {
    id,
    userId: String(userId),
    type,
    amount: amountStr,
    status,
    createdAt: new Date().toISOString(),
    ...extra
  };
  await db.collection(COL.BILLS).doc(id).set(bill);
  return bill;
}

// ============================================================================
// 4. 3-TIER REFERRAL COMMISSION & TEAM ENGINE
// ============================================================================
async function distributeReferralCommission(buyerUser, purchaseAmount) {
  if (!buyerUser || !buyerUser.invitedBy || purchaseAmount <= 0) return;

  const tiers = [
    { level: 1, rate: COMMISSION_RATES.level1, code: buyerUser.invitedBy },
    { level: 2, rate: COMMISSION_RATES.level2, code: null },
    { level: 3, rate: COMMISSION_RATES.level3, code: null }
  ];

  let currentCode = buyerUser.invitedBy;

  for (let i = 0; i < tiers.length; i++) {
    if (!currentCode || currentCode === 'NONE') break;
    const upline = await getUserByInviteCode(currentCode);
    if (!upline || upline.id === buyerUser.id) break;

    const commission = round2(purchaseAmount * tiers[i].rate);
    if (commission > 0) {
      const uplineRef = db.collection(COL.USERS).doc(upline.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(uplineRef);
        if (!snap.exists) return;
        const data = snap.data();
        const nextWithdrawal = round2(Number(data.withdrawalBalance || 0) + commission);
        const nextTeamIncome = round2(Number(data.teamCommission || 0) + commission);
        tx.update(uplineRef, {
          withdrawalBalance: nextWithdrawal,
          teamCommission: nextTeamIncome
        });
      });

      await recordBill(
        upline.id,
        `Bonus (L${tiers[i].level} Referral)`,
        `+₹${commission.toFixed(2)}`,
        'Success',
        { fromUserId: buyerUser.id, tier: tiers[i].level }
      );
    }

    currentCode = upline.invitedBy;
  }
}

async function getTeamSummary(user) {
  if (!user || !user.ownInviteCode) {
    return { totalCount: 0, level1: [], level2: [], level3: [], todayInvites: 0 };
  }

  const l1Snap = await db.collection(COL.USERS).where('invitedBy', '==', user.ownInviteCode).get();
  const level1 = l1Snap.docs.map(d => d.data());

  let level2 = [];
  for (const m1 of level1) {
    if (m1.ownInviteCode) {
      const s2 = await db.collection(COL.USERS).where('invitedBy', '==', m1.ownInviteCode).get();
      level2.push(...s2.docs.map(d => d.data()));
    }
  }

  let level3 = [];
  for (const m2 of level2) {
    if (m2.ownInviteCode) {
      const s3 = await db.collection(COL.USERS).where('invitedBy', '==', m2.ownInviteCode).get();
      level3.push(...s3.docs.map(d => d.data()));
    }
  }

  const today = todayKeyIST();
  const todayInvites = level1.filter(u => String(u.createdAt || '').startsWith(today)).length;

  const sanitizeMember = (m) => ({
    id: m.id,
    phone: m.phone ? m.phone.slice(0, 3) + '****' + m.phone.slice(-3) : '—',
    realName: m.realName || 'Member',
    vipLevel: Number(m.vipLevel || 0),
    totalInvestment: Number(m.totalInvestment || 0),
    createdAt: m.createdAt
  });

  return {
    totalCount: level1.length + level2.length + level3.length,
    todayInvites,
    level1: level1.map(sanitizeMember),
    level2: level2.map(sanitizeMember),
    level3: level3.map(sanitizeMember)
  };
}

// ============================================================================
// 5. AUTOMATED DAILY ROI SETTLEMENT ENGINE
// ============================================================================
async function processDailyOrderReturns() {
  try {
    const activeSnap = await db.collection(COL.ORDERS).where('status', '==', 'Active').get();
    if (activeSnap.empty) return;

    const nowMs = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    for (const doc of activeSnap.docs) {
      const order = { id: doc.id, ...doc.data() };
      const lastPaidMs = new Date(order.lastPayoutAt || order.createdAt || nowMs).getTime();
      const elapsedDays = Math.floor((nowMs - lastPaidMs) / ONE_DAY_MS);

      if (elapsedDays < 1) continue;

      const totalDays = Number(order.durationDays || 1);
      const alreadyPaidDays = Number(order.daysPaid || 0);
      const remainingDays = Math.max(0, totalDays - alreadyPaidDays);
      const payableDays = Math.min(elapsedDays, remainingDays);

      if (payableDays <= 0) {
        await doc.ref.update({ status: 'Completed' });
        continue;
      }

      const payoutAmount = round2(Number(order.dailyIncome || 0) * payableDays);
      const nextDaysPaid = alreadyPaidDays + payableDays;
      const isCompleted = nextDaysPaid >= totalDays;

      const userRef = db.collection(COL.USERS).doc(String(order.userId));
      await db.runTransaction(async (tx) => {
        const uSnap = await tx.get(userRef);
        if (!uSnap.exists) return;
        const uData = uSnap.data();
        const nextWithdrawal = round2(Number(uData.withdrawalBalance || 0) + payoutAmount);
        const nextTotalEarnings = round2(Number(uData.totalEarnings || 0) + payoutAmount);

        tx.update(userRef, {
          withdrawalBalance: nextWithdrawal,
          totalEarnings: nextTotalEarnings
        });

        tx.update(doc.ref, {
          daysPaid: nextDaysPaid,
          lastPayoutAt: new Date(lastPaidMs + payableDays * ONE_DAY_MS).toISOString(),
          status: isCompleted ? 'Completed' : 'Active'
        });
      });

      await recordBill(
        order.userId,
        'Return',
        `+₹${payoutAmount.toFixed(2)}`,
        'Success',
        { orderId: order.id, productName: order.productName, days: payableDays }
      );
    }
  } catch (err) {
    console.error('Daily ROI settlement error:', err.message);
  }
}

// ============================================================================
// 6. PUBLIC & USER ROUTES
// ============================================================================
app.use('/api', rateLimit(150, 60000));

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'GrowthWave Capital Full Firebase API',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/config', async (req, res) => {
  try {
    const config = await getConfig();
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- AUTHENTICATION ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, withdrawPassword, inviteCode, realName } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);

    if (cleanPhone.length !== 10 || !password || !withdrawPassword) {
      return res.json({ success: false, message: '10-digit phone, login password, and withdrawal password are required' });
    }

    const existing = await getUserByPhone(cleanPhone);
    if (existing) {
      return res.json({ success: false, message: 'Mobile number is already registered' });
    }

    let validInviteCode = null;
    if (inviteCode && String(inviteCode).trim().toUpperCase() !== 'NONE') {
      const inviter = await getUserByInviteCode(inviteCode);
      if (inviter) {
        validInviteCode = inviter.ownInviteCode;
        // Award +1 lucky spin to inviter
        await db.collection(COL.USERS).doc(inviter.id).update({
          spins: admin.firestore.FieldValue.increment(1)
        });
      }
    }

    const counterRef = db.collection(COL.META).doc('counters');
    const userId = await db.runTransaction(async (tx) => {
      const cSnap = await tx.get(counterRef);
      const currentSeq = cSnap.exists ? Number(cSnap.data().userSeq || 100000) : 100000;
      const nextSeq = currentSeq + 1;
      tx.set(counterRef, { userSeq: nextSeq }, { merge: true });
      return String(nextSeq);
    });

    const newUser = {
      id: userId,
      phone: cleanPhone,
      password: String(password),
      withdrawPassword: String(withdrawPassword),
      realName: String(realName || '').trim() || `Member_${cleanPhone.slice(-4)}`,
      ownInviteCode: `INV${userId}`,
      invitedBy: validInviteCode,
      chargedBalance: 0,
      withdrawalBalance: 0,
      totalInvestment: 0,
      totalRecharge: 0,
      totalWithdraw: 0,
      totalEarnings: 0,
      teamCommission: 0,
      vipLevel: 0,
      spins: 3,
      checkinStreak: 0,
      lastCheckinDate: '',
      claimedPromos: [],
      claimedTasks: [],
      banned: false,
      createdAt: new Date().toISOString()
    };

    await db.collection(COL.USERS).doc(userId).set(newUser);
    res.json({ success: true, userId, user: newUser, message: 'Account created successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
    const user = await getUserByPhone(cleanPhone);

    if (!user || user.password !== String(password)) {
      return res.json({ success: false, message: 'Invalid mobile number or password' });
    }
    if (user.banned) {
      return res.json({ success: false, message: 'Account suspended. Contact support.' });
    }

    res.json({ success: true, userId: user.id, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { userId, oldPassword, newPassword, type = 'login' } = req.body || {};
    const user = await getUserById(userId);
    if (!user) return res.json({ success: false, message: 'User not found' });

    const field = type === 'withdraw' ? 'withdrawPassword' : 'password';
    if (String(user[field]) !== String(oldPassword)) {
      return res.json({ success: false, message: 'Current password is incorrect' });
    }
    if (!newPassword || String(newPassword).length < 4) {
      return res.json({ success: false, message: 'New password must be at least 4 characters' });
    }

    await db.collection(COL.USERS).doc(user.id).update({ [field]: String(newPassword) });
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- PRODUCTS & INVESTMENT ---
app.get('/api/products', async (req, res) => {
  try {
    const products = await getAllProducts();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/products/buy', async (req, res) => {
  try {
    const { userId, productId, copies = 1 } = req.body || {};
    const qty = Math.max(1, Math.floor(Number(copies || 1)));

    const userRef = db.collection(COL.USERS).doc(String(userId));
    const prodRef = db.collection(COL.PRODUCTS).doc(String(productId));

    const outcome = await db.runTransaction(async (tx) => {
      const [uSnap, pSnap] = await Promise.all([tx.get(userRef), tx.get(prodRef)]);
      if (!uSnap.exists) return { ok: false, message: 'User not found' };
      if (!pSnap.exists) return { ok: false, message: 'Product not found' };

      const user = { id: uSnap.id, ...uSnap.data() };
      const product = { id: pSnap.id, ...pSnap.data() };

      if (user.banned) return { ok: false, message: 'Account restricted' };

      if (product.soldOut || (product.isLimited && Number(product.remainingCopies || 0) < qty)) {
        return {
          ok: false,
          message: product.soldOutMessage || 'Product khatam ho gaya hai koi or product buy karo thank you'
        };
      }

      const requiredVip = Number(product.vipLevel || 0);
      if (Number(user.vipLevel || 0) < requiredVip && Number(user.totalInvestment || 0) === 0 && requiredVip > 1) {
        return { ok: false, message: `VIP ${requiredVip} required for this plan` };
      }

      const totalCost = round2(Number(product.price || 0) * qty);
      let charged = Number(user.chargedBalance || 0);
      let withdrawal = Number(user.withdrawalBalance || 0);

      if (round2(charged + withdrawal) < totalCost) {
        return { ok: false, message: `Insufficient balance (Need ₹${totalCost}). Please recharge first.` };
      }

      let rem = totalCost;
      if (charged >= rem) {
        charged = round2(charged - rem);
        rem = 0;
      } else {
        rem = round2(rem - charged);
        charged = 0;
        withdrawal = round2(withdrawal - rem);
      }

      const prodUpdates = {};
      if (product.isLimited) {
        const nextRemaining = Math.max(0, Number(product.remainingCopies || 0) - qty);
        prodUpdates.remainingCopies = nextRemaining;
        if (nextRemaining === 0) prodUpdates.soldOut = true;
      }

      const nextInvestment = round2(Number(user.totalInvestment || 0) + totalCost);
      const nextVip = calcVipLevel(nextInvestment);
      const nextSpins = Number(user.spins || 0) + 1; // +1 lucky wheel spin on purchase

      tx.update(userRef, {
        chargedBalance: charged,
        withdrawalBalance: withdrawal,
        totalInvestment: nextInvestment,
        vipLevel: nextVip,
        spins: nextSpins
      });

      if (Object.keys(prodUpdates).length > 0) {
        tx.update(prodRef, prodUpdates);
      }

      const orderId = genId('ORD');
      const nowIso = new Date().toISOString();
      const order = {
        id: orderId,
        userId: user.id,
        productId: product.id,
        productName: product.name,
        copies: qty,
        totalAmount: totalCost,
        dailyIncome: round2(Number(product.dailyIncome || 0) * qty),
        durationDays: Number(product.durationDays || 1),
        daysPaid: 0,
        lastPayoutAt: nowIso,
        status: 'Active',
        createdAt: nowIso
      };

      tx.set(db.collection(COL.ORDERS).doc(orderId), order);

      return { ok: true, order, totalCost, userSnapshot: user };
    });

    if (!outcome.ok) {
      return res.json({ success: false, message: outcome.message });
    }

    await recordBill(userId, 'Investment', `-₹${outcome.totalCost.toFixed(2)}`, 'Success', {
      orderId: outcome.order.id,
      productName: outcome.order.productName
    });

    await distributeReferralCommission(outcome.userSnapshot, outcome.totalCost);

    res.json({
      success: true,
      order: outcome.order,
      message: `${outcome.order.productName} purchased! +1 Lucky Spin unlocked.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- RECHARGE FLOW ---
app.post('/api/recharge/create', async (req, res) => {
  try {
    const { userId, amount, channel } = req.body || {};
    const user = await getUserById(userId);
    if (!user) return res.json({ success: false, message: 'User not found' });

    const cfg = await getConfig();
    const numAmt = round2(amount);
    if (numAmt < Number(cfg.minRecharge || 100)) {
      return res.json({ success: false, message: `Minimum recharge is ₹${cfg.minRecharge || 100}` });
    }

    const orderId = genId('RCH');
    const rechargeDoc = {
      id: orderId,
      txId: orderId,
      userId: user.id,
      userPhone: user.phone,
      amount: numAmt,
      channel: channel || 'PaytmPay',
      utr: '',
      status: 'Created',
      createdAt: new Date().toISOString()
    };

    await db.collection(COL.RECHARGES).doc(orderId).set(rechargeDoc);
    res.json({ success: true, orderId, amount: numAmt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/recharge/verify', async (req, res) => {
  try {
    const { userId, amount, razorpay_order_id, utr } = req.body || {};
    const user = await getUserById(userId);
    if (!user) return res.json({ success: false, message: 'User not found' });

    const cleanUtr = String(utr || '').trim();
    if (!cleanUtr || cleanUtr.length < 6) {
      return res.json({ success: false, message: 'Valid UTR number is required' });
    }

    // Check duplicate UTR
    const dupSnap = await db.collection(COL.RECHARGES).where('utr', '==', cleanUtr).limit(1).get();
    if (!dupSnap.empty && dupSnap.docs[0].id !== razorpay_order_id) {
      return res.json({ success: false, message: 'This UTR has already been submitted' });
    }

    const numAmt = round2(amount);
    const orderId = razorpay_order_id || genId('RCH');
    const rRef = db.collection(COL.RECHARGES).doc(String(orderId));
    const rSnap = await rRef.get();

    if (rSnap.exists) {
      await rRef.update({
        utr: cleanUtr,
        txId: cleanUtr,
        status: 'Pending',
        submittedAt: new Date().toISOString()
      });
    } else {
      await rRef.set({
        id: orderId,
        txId: cleanUtr,
        utr: cleanUtr,
        userId: user.id,
        userPhone: user.phone,
        amount: numAmt,
        channel: 'UPI',
        status: 'Pending',
        createdAt: new Date().toISOString()
      });
    }

    await recordBill(user.id, 'Recharge', `+₹${numAmt.toFixed(2)}`, 'Pending', {
      txId: cleanUtr,
      orderId
    });

    // Returns success:false so frontend marks as Pending until admin approves (prevents fake credit)
    res.json({
      success: false,
      status: 'Pending',
      message: 'UTR submitted for verification. Balance credits after approval.'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/recharge/history/:uid', async (req, res) => {
  try {
    const snap = await db.collection(COL.RECHARGES).where('userId', '==', String(req.params.uid)).get();
    const recharges = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.status !== 'Created')
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, recharges });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- WITHDRAWAL FLOW ---
app.post('/api/withdraw/auto-upi', async (req, res) => {
  try {
    const { userId, amount, withdrawPassword, bankName, realName, bankAccount, bankCode, upiId } = req.body || {};
    const cfg = await getConfig();
    const numAmt = round2(amount);

    if (numAmt < Number(cfg.minWithdraw || 110)) {
      return res.json({ success: false, message: `Minimum withdrawal is ₹${cfg.minWithdraw || 110}` });
    }
    if (numAmt > Number(cfg.maxDailyWithdraw || 50000)) {
      return res.json({ success: false, message: `Maximum daily withdrawal is ₹${cfg.maxDailyWithdraw || 50000}` });
    }

    const userRef = db.collection(COL.USERS).doc(String(userId));
    const outcome = await db.runTransaction(async (tx) => {
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) return { ok: false, message: 'User not found' };
      const user = { id: uSnap.id, ...uSnap.data() };

      if (user.banned) return { ok: false, message: 'Account restricted' };
      if (String(withdrawPassword || '') !== String(user.withdrawPassword || '')) {
        return { ok: false, message: 'Incorrect withdrawal password' };
      }

      const currentBalance = Number(user.withdrawalBalance || 0);
      if (currentBalance < numAmt) {
        return { ok: false, message: 'Insufficient withdrawal balance' };
      }

      const nextBalance = round2(currentBalance - numAmt);
      const nextTotalWithdraw = round2(Number(user.totalWithdraw || 0) + numAmt);

      tx.update(userRef, {
        withdrawalBalance: nextBalance,
        totalWithdraw: nextTotalWithdraw
      });

      const wdId = genId('WD');
      const wd = {
        id: wdId,
        userId: user.id,
        userPhone: user.phone,
        amount: numAmt,
        bankName: String(bankName || '').trim(),
        realName: String(realName || '').trim(),
        bankAccount: String(bankAccount || '').trim(),
        bankCode: String(bankCode || '').trim().toUpperCase(),
        upiId: String(upiId || '').trim(),
        status: 'Pending',
        createdAt: new Date().toISOString()
      };
      tx.set(db.collection(COL.WITHDRAWALS).doc(wdId), wd);

      return { ok: true, withdrawal: wd };
    });

    if (!outcome.ok) {
      return res.json({ success: false, message: outcome.message });
    }

    await recordBill(userId, 'Withdrawal', `-₹${numAmt.toFixed(2)}`, 'Pending', {
      withdrawalId: outcome.withdrawal.id
    });

    res.json({
      success: true,
      withdrawal: outcome.withdrawal,
      message: 'Withdrawal submitted! Funds will arrive within 24 hours.'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/withdraw/history/:uid', async (req, res) => {
  try {
    const snap = await db.collection(COL.WITHDRAWALS).where('userId', '==', String(req.params.uid)).get();
    const withdrawals = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- DAILY CHECK-IN, LUCKY WHEEL & TASKS ---
app.post('/api/checkin', async (req, res) => {
  try {
    const { userId } = req.body || {};
    const cfg = await getConfig();
    const reward = Number(cfg.checkinReward || 14);
    const today = todayKeyIST();

    const userRef = db.collection(COL.USERS).doc(String(userId));
    const outcome = await db.runTransaction(async (tx) => {
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) return { ok: false, message: 'User not found' };
      const user = uSnap.data();

      if (user.lastCheckinDate === today) {
        return { ok: false, message: 'Already signed in today! Come back tomorrow.' };
      }

      const nextStreak = Number(user.checkinStreak || 0) + 1;
      const nextBalance = round2(Number(user.withdrawalBalance || 0) + reward);

      tx.update(userRef, {
        lastCheckinDate: today,
        checkinStreak: nextStreak,
        withdrawalBalance: nextBalance
      });

      return { ok: true, streak: nextStreak };
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    await recordBill(userId, 'Bonus (Daily Check-In)', `+₹${reward.toFixed(2)}`, 'Success');
    res.json({ success: true, reward, streak: outcome.streak, message: `Signed in! +₹${reward} credited.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/lucky/spin', async (req, res) => {
  try {
    const { userId } = req.body || {};
    const prizes = [
      { num: 1, label: '₹5', amount: 5 },
      { num: 2, label: '₹10', amount: 10 },
      { num: 3, label: '₹15', amount: 15 },
      { num: 4, label: '₹20', amount: 20 },
      { num: 6, label: '₹25', amount: 25 },
      { num: 7, label: '₹30', amount: 30 },
      { num: 8, label: '₹40', amount: 40 },
      { num: 9, label: '₹50', amount: 50 }
    ];

    const chosen = prizes[Math.floor(Math.random() * prizes.length)];
    const userRef = db.collection(COL.USERS).doc(String(userId));

    const outcome = await db.runTransaction(async (tx) => {
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) return { ok: false, message: 'User not found' };
      const user = uSnap.data();
      const currentSpins = Number(user.spins || 0);
      if (currentSpins <= 0) return { ok: false, message: 'No spins remaining' };

      const nextBalance = round2(Number(user.withdrawalBalance || 0) + chosen.amount);
      tx.update(userRef, {
        spins: currentSpins - 1,
        withdrawalBalance: nextBalance
      });
      return { ok: true, spinsLeft: currentSpins - 1 };
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    await recordBill(userId, 'Bonus (Lucky Wheel)', `+₹${chosen.amount.toFixed(2)}`, 'Success');
    res.json({
      success: true,
      prize: chosen,
      spinsLeft: outcome.spinsLeft,
      message: `Congratulations! You won ${chosen.label}`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/tasks/claim', async (req, res) => {
  try {
    const { userId, taskId } = req.body || {};
    const user = await getUserById(userId);
    if (!user) return res.json({ success: false, message: 'User not found' });

    const team = await getTeamSummary(user);
    const allTasks = [
      ...DAILY_TASKS.map(t => ({ ...t, type: 'daily', progress: team.todayInvites })),
      ...CUMULATIVE_TASKS.map(t => ({ ...t, type: 'cumulative', progress: team.level1.length }))
    ];

    const task = allTasks.find(t => t.id === taskId);
    if (!task) return res.json({ success: false, message: 'Task not found' });

    const claimKey = task.type === 'daily' ? `${task.id}_${todayKeyIST()}` : task.id;
    const claimedList = Array.isArray(user.claimedTasks) ? user.claimedTasks : [];

    if (claimedList.includes(claimKey)) {
      return res.json({ success: false, message: 'Task reward already claimed' });
    }
    if (task.progress < task.count) {
      return res.json({ success: false, message: `Progress ${task.progress}/${task.count}. Invite more members.` });
    }

    const userRef = db.collection(COL.USERS).doc(user.id);
    await userRef.update({
      withdrawalBalance: round2(Number(user.withdrawalBalance || 0) + task.reward),
      claimedTasks: [...claimedList, claimKey]
    });

    await recordBill(user.id, 'Bonus (Task Reward)', `+₹${task.reward.toFixed(2)}`, 'Success');
    res.json({ success: true, reward: task.reward, message: `₹${task.reward} task bonus claimed!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/team/:uid', async (req, res) => {
  try {
    const user = await getUserById(req.params.uid);
    if (!user) return res.json({ success: false, message: 'User not found' });
    const team = await getTeamSummary(user);
    res.json({ success: true, team });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- BILLS & FULL LIVE SYNC ---
app.get('/api/bills/:uid', async (req, res) => {
  try {
    const snap = await db.collection(COL.BILLS).where('userId', '==', String(req.params.uid)).get();
    const bills = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, bills });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/live-sync/:uid', async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const user = await getUserById(uid);
    if (!user) {
      return res.json({ success: false, message: 'Session expired. Please login again.' });
    }

    const [products, ordersSnap, ticketsSnap, noticesSnap, config, team] = await Promise.all([
      getAllProducts(),
      db.collection(COL.ORDERS).where('userId', '==', uid).get(),
      db.collection(COL.TICKETS).where('userId', '==', uid).get(),
      db.collection(COL.NOTICES).get(),
      getConfig(),
      getTeamSummary(user)
    ]);

    const myProducts = ordersSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const tickets = ticketsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const notices = noticesSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({
      success: true,
      user,
      products,
      myProducts,
      tickets,
      notices,
      team,
      checkedInToday: user.lastCheckinDate === todayKeyIST(),
      config
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- PROMO, COMMUNITY BLOG, SUPPORT TICKETS & NOTICES ---
app.post('/api/promo/claim', async (req, res) => {
  try {
    const { userId, code } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode) return res.json({ success: false, message: 'Enter a valid promo code' });

    const promoRef = db.collection(COL.PROMOS).doc(cleanCode);
    const userRef = db.collection(COL.USERS).doc(String(userId));

    const outcome = await db.runTransaction(async (tx) => {
      const [pSnap, uSnap] = await Promise.all([tx.get(promoRef), tx.get(userRef)]);
      if (!pSnap.exists || pSnap.data().active === false) {
        return { ok: false, message: 'Invalid or expired promo code' };
      }
      if (!uSnap.exists) return { ok: false, message: 'User not found' };

      const promo = pSnap.data();
      const user = uSnap.data();

      if (promo.maxUses && Number(promo.usedCount || 0) >= Number(promo.maxUses)) {
        return { ok: false, message: 'Promo code usage limit reached' };
      }

      const claimed = Array.isArray(user.claimedPromos) ? user.claimedPromos : [];
      if (claimed.includes(cleanCode)) {
        return { ok: false, message: 'You have already claimed this code' };
      }

      const reward = round2(promo.reward || 0);
      tx.update(userRef, {
        withdrawalBalance: round2(Number(user.withdrawalBalance || 0) + reward),
        claimedPromos: [...claimed, cleanCode]
      });
      tx.update(promoRef, {
        usedCount: Number(promo.usedCount || 0) + 1
      });

      return { ok: true, reward };
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    await recordBill(userId, 'Promo', `+₹${outcome.reward.toFixed(2)}`, 'Success', { code: cleanCode });
    res.json({ success: true, message: `₹${outcome.reward} added to your withdrawal balance!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/blog/list', async (req, res) => {
  try {
    const snap = await db.collection(COL.BLOG).get();
    const posts = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/blog/submit', async (req, res) => {
  try {
    const { userId, text, images } = req.body || {};
    const cleanText = String(text || '').trim();
    const cleanImages = Array.isArray(images) ? images.filter(Boolean).slice(0, 2) : [];

    if (!cleanText && cleanImages.length === 0) {
      return res.json({ success: false, message: 'Please enter text or image URL' });
    }

    const postId = genId('POST');
    const post = {
      id: postId,
      userId: String(userId || 'Guest'),
      text: cleanText,
      images: cleanImages,
      createdAt: new Date().toISOString()
    };
    await db.collection(COL.BLOG).doc(postId).set(post);
    res.json({ success: true, post });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/service/ticket', async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    const cleanMsg = String(message || '').trim();
    if (!cleanMsg) return res.json({ success: false, message: 'Please enter your message' });

    const ticketId = genId('TKT');
    const ticket = {
      id: ticketId,
      userId: String(userId || 'Guest'),
      message: cleanMsg,
      status: 'Open',
      adminReply: '',
      createdAt: new Date().toISOString()
    };
    await db.collection(COL.TICKETS).doc(ticketId).set(ticket);
    res.json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/notices', async (req, res) => {
  try {
    const snap = await db.collection(COL.NOTICES).get();
    const notices = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, notices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 7. FULL ADMIN PANEL MANAGEMENT ROUTES
// ============================================================================
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const [usersSnap, ordersSnap, rchSnap, wdSnap, ticketsSnap] = await Promise.all([
      db.collection(COL.USERS).get(),
      db.collection(COL.ORDERS).get(),
      db.collection(COL.RECHARGES).get(),
      db.collection(COL.WITHDRAWALS).get(),
      db.collection(COL.TICKETS).get()
    ]);

    const users = usersSnap.docs.map(d => d.data());
    const recharges = rchSnap.docs.map(d => d.data());
    const withdrawals = wdSnap.docs.map(d => d.data());

    const totalRechargeApproved = recharges
      .filter(r => r.status === 'Success')
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);

    const totalWithdrawApproved = withdrawals
      .filter(w => w.status === 'Success')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0);

    res.json({
      success: true,
      stats: {
        totalUsers: users.length,
        totalOrders: ordersSnap.size,
        pendingRecharges: recharges.filter(r => r.status === 'Pending').length,
        pendingWithdrawals: withdrawals.filter(w => w.status === 'Pending').length,
        openTickets: ticketsSnap.docs.filter(d => d.data().status === 'Open').length,
        totalRechargeApproved: round2(totalRechargeApproved),
        totalWithdrawApproved: round2(totalWithdrawApproved)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/config', adminAuth, async (req, res) => {
  try {
    const updates = req.body || {};
    delete updates.adminKey;
    await db.collection(COL.META).doc('config').set(updates, { merge: true });
    const config = await getConfig();
    res.json({ success: true, config, message: 'Config updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Users Management
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.USERS).get();
    const users = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users/:uid', adminAuth, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const body = { ...(req.body || {}) };
    delete body.adminKey;
    if (body.totalInvestment !== undefined) {
      body.vipLevel = calcVipLevel(body.totalInvestment);
    }
    await db.collection(COL.USERS).doc(uid).update(body);
    const updated = await getUserById(uid);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Products CRUD
app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const id = body.id || genId('PROD');
    const product = {
      id,
      name: String(body.name || 'New Plan'),
      image: String(body.image || ''),
      vipLevel: Number(body.vipLevel || 0),
      price: Number(body.price || 100),
      dailyIncome: Number(body.dailyIncome || 10),
      durationDays: Number(body.durationDays || 30),
      isLimited: Boolean(body.isLimited),
      remainingCopies: Number(body.remainingCopies || 0),
      totalCopies: Number(body.totalCopies || body.remainingCopies || 0),
      soldOut: Boolean(body.soldOut),
      soldOutMessage: String(body.soldOutMessage || 'Product khatam ho gaya hai koi or product buy karo thank you')
    };
    await db.collection(COL.PRODUCTS).doc(id).set(product, { merge: true });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    await db.collection(COL.PRODUCTS).doc(String(req.params.id)).delete();
    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Recharge Approve / Reject
app.get('/api/admin/recharges', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.RECHARGES).get();
    const recharges = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, recharges });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/recharges/:id/action', adminAuth, async (req, res) => {
  try {
    const { action } = req.body || {}; // 'approve' or 'reject'
    const rRef = db.collection(COL.RECHARGES).doc(String(req.params.id));

    const outcome = await db.runTransaction(async (tx) => {
      const rSnap = await tx.get(rRef);
      if (!rSnap.exists) return { ok: false, message: 'Recharge record not found' };
      const rec = rSnap.data();

      if (rec.status === 'Success' || rec.status === 'Rejected') {
        return { ok: false, message: `Already ${rec.status}` };
      }

      if (action === 'approve') {
        const uRef = db.collection(COL.USERS).doc(String(rec.userId));
        const uSnap = await tx.get(uRef);
        if (!uSnap.exists) return { ok: false, message: 'User not found' };
        const user = uSnap.data();
        const amt = round2(rec.amount);

        tx.update(uRef, {
          chargedBalance: round2(Number(user.chargedBalance || 0) + amt),
          totalRecharge: round2(Number(user.totalRecharge || 0) + amt)
        });
        tx.update(rRef, { status: 'Success', approvedAt: new Date().toISOString() });
        return { ok: true, status: 'Success', rec };
      } else {
        tx.update(rRef, { status: 'Rejected', rejectedAt: new Date().toISOString() });
        return { ok: true, status: 'Rejected', rec };
      }
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    // Update matching pending bill if found
    const billSnap = await db.collection(COL.BILLS).where('orderId', '==', outcome.rec.id).limit(1).get();
    if (!billSnap.empty) {
      await billSnap.docs[0].ref.update({ status: outcome.status });
    }

    res.json({ success: true, status: outcome.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Withdrawal Approve / Reject (Refunds balance on Reject)
app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.WITHDRAWALS).get();
    const withdrawals = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/withdrawals/:id/action', adminAuth, async (req, res) => {
  try {
    const { action } = req.body || {}; // 'approve' or 'reject'
    const wRef = db.collection(COL.WITHDRAWALS).doc(String(req.params.id));

    const outcome = await db.runTransaction(async (tx) => {
      const wSnap = await tx.get(wRef);
      if (!wSnap.exists) return { ok: false, message: 'Withdrawal record not found' };
      const wd = wSnap.data();

      if (wd.status === 'Success' || wd.status === 'Rejected') {
        return { ok: false, message: `Already ${wd.status}` };
      }

      if (action === 'approve') {
        tx.update(wRef, { status: 'Success', approvedAt: new Date().toISOString() });
        return { ok: true, status: 'Success', wd };
      } else {
        const uRef = db.collection(COL.USERS).doc(String(wd.userId));
        const uSnap = await tx.get(uRef);
        if (uSnap.exists) {
          const user = uSnap.data();
          const amt = round2(wd.amount);
          tx.update(uRef, {
            withdrawalBalance: round2(Number(user.withdrawalBalance || 0) + amt),
            totalWithdraw: Math.max(0, round2(Number(user.totalWithdraw || 0) - amt))
          });
        }
        tx.update(wRef, { status: 'Rejected', rejectedAt: new Date().toISOString() });
        return { ok: true, status: 'Rejected', wd };
      }
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    const billSnap = await db.collection(COL.BILLS).where('withdrawalId', '==', outcome.wd.id).limit(1).get();
    if (!billSnap.empty) {
      await billSnap.docs[0].ref.update({ status: outcome.status });
    }

    res.json({ success: true, status: outcome.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Promos, Notices & Tickets
app.post('/api/admin/promos', adminAuth, async (req, res) => {
  try {
    const { code, reward, maxUses = 1000 } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode || !reward) return res.json({ success: false, message: 'Code and reward required' });

    const promo = {
      code: cleanCode,
      reward: round2(reward),
      maxUses: Number(maxUses),
      usedCount: 0,
      active: true,
      createdAt: new Date().toISOString()
    };
    await db.collection(COL.PROMOS).doc(cleanCode).set(promo);
    res.json({ success: true, promo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/notices', adminAuth, async (req, res) => {
  try {
    const { title, summary, content, icon = 'bell' } = req.body || {};
    const id = genId('NTC');
    const notice = {
      id,
      icon,
      title: String(title || 'Announcement'),
      summary: String(summary || ''),
      content: String(content || ''),
      date: todayKeyIST(),
      createdAt: new Date().toISOString()
    };
    await db.collection(COL.NOTICES).doc(id).set(notice);
    res.json({ success: true, notice });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/tickets', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.TICKETS).get();
    const tickets = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/tickets/:id/reply', adminAuth, async (req, res) => {
  try {
    const { reply } = req.body || {};
    await db.collection(COL.TICKETS).doc(String(req.params.id)).update({
      adminReply: String(reply || '').trim(),
      status: 'Replied',
      repliedAt: new Date().toISOString()
    });
    res.json({ success: true, message: 'Reply sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 8. 404 FALLBACK & SERVER STARTUP
// ============================================================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

seedInitialData()
  .then(() => {
    // Run daily ROI check immediately on boot and every 30 minutes
    processDailyOrderReturns();
    setInterval(processDailyOrderReturns, 30 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`GrowthWave Full Firebase Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Startup error:', err.message);
    app.listen(PORT, () => {
      console.log(`Server started on port ${PORT} (check Firebase credentials)`);
    });
  });
