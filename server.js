const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = String(process.env.ADMIN_SECRET || 'GW_ADMIN_2026').trim();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// 1. SAFE SERVICE ACCOUNT PARSER & FIRESTORE INIT (firegan-c593c)
// ============================================================================
function parseServiceAccount(raw) {
  if (!raw) return null;
  let text = String(raw).trim();

  // Strip accidental outer wrapping quotes
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    try {
      const parsedOnce = JSON.parse(text);
      if (parsedOnce && typeof parsedOnce === 'object') return parsedOnce;
      if (typeof parsedOnce === 'string') text = parsedOnce;
    } catch (_) {}
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    // Fix literal newlines inside private_key if pasted across multiple lines
    const normalized = text.replace(/\r?\n/g, '\\n');
    return JSON.parse(normalized);
  }
}

function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  const rawEnv =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    '';

  let cred = parseServiceAccount(rawEnv);

  if (!cred) {
    const keyFile = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(keyFile)) {
      cred = parseServiceAccount(fs.readFileSync(keyFile, 'utf8'));
    }
  }

  if (!cred || typeof cred !== 'object') {
    throw new Error('Firebase service account missing. Set FIREBASE_SERVICE_ACCOUNT_JSON.');
  }

  if (cred.private_key && typeof cred.private_key === 'string') {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }

  const projectId = String(cred.project_id || cred.projectId || 'firegan-c593c').trim();

  admin.initializeApp({
    credential: admin.credential.cert(cred),
    projectId
  });

  const firestore = admin.firestore();
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

const db = initFirebase();

// ============================================================================
// 2. COLLECTIONS, CONSTANTS & HELPERS
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
  NOTICES: 'notices'
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
  level1: 0.60,
  level2: 0.04,
  level3: 0.01
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
  homeBanner: { image: '', text: 'GrowthWave Capital — Daily Returns & 3-Tier Referral Rewards!' },
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
  }
];

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function calcVipLevel(totalInvestment) {
  let lvl = 0;
  for (const t of VIP_TIERS) {
    if (Number(totalInvestment || 0) >= t.req) lvl = t.level;
  }
  return lvl;
}

function todayKeyIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function adminAuth(req, res, next) {
  const token = String(
    req.headers['x-admin-key'] ||
    req.headers['X-Admin-Key'] ||
    req.query.adminKey ||
    (req.body && req.body.adminKey) ||
    ''
  ).trim();

  if (!token || token !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized: invalid admin key' });
  }
  next();
}

// ============================================================================
// 3. FIRESTORE DATA ACCESS & SEEDING
// ============================================================================
async function seedDefaults() {
  const cfgRef = db.collection(COL.META).doc('config');
  const cfgSnap = await cfgRef.get();
  if (!cfgSnap.exists) {
    await cfgRef.set(DEFAULT_CONFIG);
  }

  const prodSnap = await db.collection(COL.PRODUCTS).limit(1).get();
  if (prodSnap.empty) {
    const batch = db.batch();
    for (const p of DEFAULT_PRODUCTS) {
      batch.set(db.collection(COL.PRODUCTS).doc(p.id), p);
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
      summary: 'New Firebase backend active with instant wallet sync & daily returns.',
      content: '<p>Invest in active plans, invite friends across 3 tiers, and manage everything from the Admin Panel.</p>',
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
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
}

async function getUserById(uid) {
  if (!uid) return null;
  const snap = await db.collection(COL.USERS).doc(String(uid)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getUserByPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!clean) return null;
  const snap = await db.collection(COL.USERS).where('phone', '==', clean).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getUserByInviteCode(code) {
  if (!code || String(code).trim().toUpperCase() === 'NONE') return null;
  const clean = String(code).trim().toUpperCase();
  const snap = await db.collection(COL.USERS).where('ownInviteCode', '==', clean).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function addBill(userId, type, amountStr, status = 'Success', extra = {}) {
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
// 4. 3-TIER REFERRAL & DAILY ROI ENGINE
// ============================================================================
async function distributeReferralCommission(buyerUser, purchaseAmount) {
  if (!buyerUser || !buyerUser.invitedBy || purchaseAmount <= 0) return;

  const rates = [COMMISSION_RATES.level1, COMMISSION_RATES.level2, COMMISSION_RATES.level3];
  let currentCode = buyerUser.invitedBy;

  for (let tierIdx = 0; tierIdx < rates.length; tierIdx++) {
    if (!currentCode || String(currentCode).toUpperCase() === 'NONE') break;
    const upline = await getUserByInviteCode(currentCode);
    if (!upline || upline.id === buyerUser.id) break;

    const commission = round2(purchaseAmount * rates[tierIdx]);
    if (commission > 0) {
      const uplineRef = db.collection(COL.USERS).doc(upline.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(uplineRef);
        if (!snap.exists) return;
        const u = snap.data();
        tx.update(uplineRef, {
          withdrawalBalance: round2(Number(u.withdrawalBalance || 0) + commission),
          teamCommission: round2(Number(u.teamCommission || 0) + commission)
        });
      });

      await addBill(
        upline.id,
        `Bonus (L${tierIdx + 1} Referral)`,
        `+₹${commission.toFixed(2)}`,
        'Success',
        { fromUserId: buyerUser.id, tier: tierIdx + 1 }
      );
    }

    currentCode = upline.invitedBy;
  }
}

async function getTeamSummary(user) {
  if (!user || !user.ownInviteCode) {
    return { totalCount: 0, todayInvites: 0, level1: [], level2: [], level3: [] };
  }

  const l1Snap = await db.collection(COL.USERS).where('invitedBy', '==', user.ownInviteCode).get();
  const level1 = l1Snap.docs.map(d => d.data());

  const level2 = [];
  for (const m1 of level1) {
    if (m1.ownInviteCode) {
      const s2 = await db.collection(COL.USERS).where('invitedBy', '==', m1.ownInviteCode).get();
      s2.docs.forEach(d => level2.push(d.data()));
    }
  }

  const level3 = [];
  for (const m2 of level2) {
    if (m2.ownInviteCode) {
      const s3 = await db.collection(COL.USERS).where('invitedBy', '==', m2.ownInviteCode).get();
      s3.docs.forEach(d => level3.push(d.data()));
    }
  }

  const today = todayKeyIST();
  const todayInvites = level1.filter(u => String(u.createdAt || '').startsWith(today)).length;

  const mask = (m) => ({
    id: m.id,
    phone: m.phone ? `${m.phone.slice(0, 3)}****${m.phone.slice(-3)}` : '—',
    realName: m.realName || 'Member',
    vipLevel: Number(m.vipLevel || 0),
    totalInvestment: Number(m.totalInvestment || 0),
    createdAt: m.createdAt
  });

  return {
    totalCount: level1.length + level2.length + level3.length,
    todayInvites,
    level1: level1.map(mask),
    level2: level2.map(mask),
    level3: level3.map(mask)
  };
}

async function processDailyOrderReturns() {
  try {
    const activeSnap = await db.collection(COL.ORDERS).where('status', '==', 'Active').get();
    if (activeSnap.empty) return;

    const nowMs = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    for (const doc of activeSnap.docs) {
      const order = { id: doc.id, ...doc.data() };
      const baseMs = new Date(order.lastPayoutAt || order.createdAt || nowMs).getTime();
      const elapsedDays = Math.floor((nowMs - baseMs) / ONE_DAY_MS);
      if (elapsedDays < 1) continue;

      const durationDays = Number(order.durationDays || 1);
      const daysPaid = Number(order.daysPaid || 0);
      const remainingDays = Math.max(0, durationDays - daysPaid);
      const payableDays = Math.min(elapsedDays, remainingDays);

      if (payableDays <= 0) {
        await doc.ref.update({ status: 'Completed' });
        continue;
      }

      const payout = round2(Number(order.dailyIncome || 0) * payableDays);
      const nextDaysPaid = daysPaid + payableDays;
      const done = nextDaysPaid >= durationDays;

      const userRef = db.collection(COL.USERS).doc(String(order.userId));
      await db.runTransaction(async (tx) => {
        const uSnap = await tx.get(userRef);
        if (!uSnap.exists) return;
        const u = uSnap.data();
        tx.update(userRef, {
          withdrawalBalance: round2(Number(u.withdrawalBalance || 0) + payout),
          totalEarnings: round2(Number(u.totalEarnings || 0) + payout)
        });
        tx.update(doc.ref, {
          daysPaid: nextDaysPaid,
          lastPayoutAt: new Date(baseMs + payableDays * ONE_DAY_MS).toISOString(),
          status: done ? 'Completed' : 'Active'
        });
      });

      await addBill(
        order.userId,
        'Return',
        `+₹${payout.toFixed(2)}`,
        'Success',
        { orderId: order.id, productName: order.productName, days: payableDays }
      );
    }
  } catch (err) {
    console.error('Daily return processing error:', err.message);
  }
}

// ============================================================================
// 5. USER & PUBLIC ROUTES
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    projectId: 'firegan-c593c',
    message: 'GrowthWave Firebase Server Online',
    time: new Date().toISOString()
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

// Auth
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, withdrawPassword, inviteCode, realName } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);

    if (cleanPhone.length !== 10 || !password || !withdrawPassword) {
      return res.json({ success: false, message: '10-digit phone, login password & withdrawal password required' });
    }

    const exists = await getUserByPhone(cleanPhone);
    if (exists) {
      return res.json({ success: false, message: 'Mobile number already registered' });
    }

    let validInviter = null;
    if (inviteCode && String(inviteCode).trim().toUpperCase() !== 'NONE') {
      const inviter = await getUserByInviteCode(inviteCode);
      if (inviter) {
        validInviter = inviter.ownInviteCode;
        await db.collection(COL.USERS).doc(inviter.id).update({
          spins: admin.firestore.FieldValue.increment(1)
        });
      }
    }

    const counterRef = db.collection(COL.META).doc('counters');
    const userId = await db.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef);
      const curr = snap.exists ? Number(snap.data().userSeq || 100000) : 100000;
      const next = curr + 1;
      tx.set(counterRef, { userSeq: next }, { merge: true });
      return String(next);
    });

    const newUser = {
      id: userId,
      phone: cleanPhone,
      password: String(password),
      withdrawPassword: String(withdrawPassword),
      realName: String(realName || '').trim() || `User_${cleanPhone.slice(-4)}`,
      ownInviteCode: `INV${userId}`,
      invitedBy: validInviter,
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
    res.json({ success: true, userId, user: newUser, message: 'Registered successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    const user = await getUserByPhone(phone);
    if (!user || user.password !== String(password)) {
      return res.json({ success: false, message: 'Invalid phone number or password' });
    }
    if (user.banned) {
      return res.json({ success: false, message: 'Account banned. Contact support.' });
    }
    res.json({ success: true, userId: user.id, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Products & Purchase
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

      const cost = round2(Number(product.price || 0) * qty);
      let charged = Number(user.chargedBalance || 0);
      let withdrawal = Number(user.withdrawalBalance || 0);

      if (round2(charged + withdrawal) < cost) {
        return { ok: false, message: `Insufficient balance (Need ₹${cost}). Please recharge.` };
      }

      let rem = cost;
      if (charged >= rem) {
        charged = round2(charged - rem);
        rem = 0;
      } else {
        rem = round2(rem - charged);
        charged = 0;
        withdrawal = round2(withdrawal - rem);
      }

      const prodPatch = {};
      if (product.isLimited) {
        const nextRem = Math.max(0, Number(product.remainingCopies || 0) - qty);
        prodPatch.remainingCopies = nextRem;
        if (nextRem === 0) prodPatch.soldOut = true;
      }

      const nextInv = round2(Number(user.totalInvestment || 0) + cost);
      const nextVip = calcVipLevel(nextInv);

      tx.update(userRef, {
        chargedBalance: charged,
        withdrawalBalance: withdrawal,
        totalInvestment: nextInv,
        vipLevel: nextVip,
        spins: Number(user.spins || 0) + 1
      });

      if (Object.keys(prodPatch).length) {
        tx.update(prodRef, prodPatch);
      }

      const orderId = genId('ORD');
      const nowIso = new Date().toISOString();
      const order = {
        id: orderId,
        userId: user.id,
        productId: product.id,
        productName: product.name,
        copies: qty,
        totalAmount: cost,
        dailyIncome: round2(Number(product.dailyIncome || 0) * qty),
        durationDays: Number(product.durationDays || 1),
        daysPaid: 0,
        lastPayoutAt: nowIso,
        status: 'Active',
        createdAt: nowIso
      };
      tx.set(db.collection(COL.ORDERS).doc(orderId), order);

      return { ok: true, order, cost, buyer: user };
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    await addBill(userId, 'Investment', `-₹${outcome.cost.toFixed(2)}`, 'Success', {
      orderId: outcome.order.id,
      productName: outcome.order.productName
    });
    await distributeReferralCommission(outcome.buyer, outcome.cost);

    res.json({ success: true, order: outcome.order, message: 'Plan purchased successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Recharge
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
    const rec = {
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
    await db.collection(COL.RECHARGES).doc(orderId).set(rec);
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
    if (!cleanUtr || cleanUtr.length < 5) {
      return res.json({ success: false, message: 'Valid UTR number required' });
    }

    const dupSnap = await db.collection(COL.RECHARGES).where('utr', '==', cleanUtr).limit(1).get();
    if (!dupSnap.empty && dupSnap.docs[0].id !== razorpay_order_id) {
      return res.json({ success: false, message: 'Duplicate UTR already submitted' });
    }

    const numAmt = round2(amount);
    const orderId = razorpay_order_id || genId('RCH');
    const rRef = db.collection(COL.RECHARGES).doc(String(orderId));
    const rSnap = await rRef.get();

    if (rSnap.exists) {
      await rRef.update({ utr: cleanUtr, txId: cleanUtr, status: 'Pending', submittedAt: new Date().toISOString() });
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

    await addBill(user.id, 'Recharge', `+₹${numAmt.toFixed(2)}`, 'Pending', { txId: cleanUtr, orderId });
    res.json({ success: false, status: 'Pending', message: 'Payment submitted for admin verification' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Withdrawal
app.post('/api/withdraw/auto-upi', async (req, res) => {
  try {
    const { userId, amount, withdrawPassword, bankName, realName, bankAccount, bankCode, upiId } = req.body || {};
    const cfg = await getConfig();
    const numAmt = round2(amount);

    if (numAmt < Number(cfg.minWithdraw || 110)) {
      return res.json({ success: false, message: `Minimum withdrawal is ₹${cfg.minWithdraw || 110}` });
    }

    const userRef = db.collection(COL.USERS).doc(String(userId));
    const outcome = await db.runTransaction(async (tx) => {
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) return { ok: false, message: 'User not found' };
      const user = { id: uSnap.id, ...uSnap.data() };

      if (user.banned) return { ok: false, message: 'Account banned' };
      if (String(withdrawPassword || '') !== String(user.withdrawPassword || '')) {
        return { ok: false, message: 'Wrong withdrawal password' };
      }

      const currW = Number(user.withdrawalBalance || 0);
      if (currW < numAmt) {
        return { ok: false, message: 'Insufficient withdrawal balance' };
      }

      tx.update(userRef, {
        withdrawalBalance: round2(currW - numAmt),
        totalWithdraw: round2(Number(user.totalWithdraw || 0) + numAmt)
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

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    await addBill(userId, 'Withdrawal', `-₹${numAmt.toFixed(2)}`, 'Pending', { withdrawalId: outcome.withdrawal.id });
    res.json({ success: true, withdrawal: outcome.withdrawal, message: 'Withdrawal request submitted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Check-In, Lucky Wheel, Tasks, Team
app.post('/api/checkin', async (req, res) => {
  try {
    const { userId } = req.body || {};
    const cfg = await getConfig();
    const reward = round2(cfg.checkinReward || 14);
    const today = todayKeyIST();
    const userRef = db.collection(COL.USERS).doc(String(userId));

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) return { ok: false, message: 'User not found' };
      const u = snap.data();
      if (u.lastCheckinDate === today) return { ok: false, message: 'Already signed in today' };

      const streak = Number(u.checkinStreak || 0) + 1;
      tx.update(userRef, {
        lastCheckinDate: today,
        checkinStreak: streak,
        withdrawalBalance: round2(Number(u.withdrawalBalance || 0) + reward)
      });
      return { ok: true, streak };
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });
    await addBill(userId, 'Bonus (Daily Check-In)', `+₹${reward.toFixed(2)}`, 'Success');
    res.json({ success: true, reward, streak: outcome.streak, message: `Check-in success! +₹${reward}` });
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
    const prize = prizes[Math.floor(Math.random() * prizes.length)];
    const userRef = db.collection(COL.USERS).doc(String(userId));

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) return { ok: false, message: 'User not found' };
      const u = snap.data();
      const spins = Number(u.spins || 0);
      if (spins <= 0) return { ok: false, message: 'No spins left' };

      tx.update(userRef, {
        spins: spins - 1,
        withdrawalBalance: round2(Number(u.withdrawalBalance || 0) + prize.amount)
      });
      return { ok: true, spinsLeft: spins - 1 };
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });
    await addBill(userId, 'Bonus (Lucky Wheel)', `+₹${prize.amount.toFixed(2)}`, 'Success');
    res.json({ success: true, prize, spinsLeft: outcome.spinsLeft, message: `Won ${prize.label}!` });
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
    const tasks = [
      ...DAILY_TASKS.map(t => ({ ...t, type: 'daily', progress: team.todayInvites })),
      ...CUMULATIVE_TASKS.map(t => ({ ...t, type: 'cumulative', progress: team.level1.length }))
    ];
    const task = tasks.find(t => t.id === taskId);
    if (!task) return res.json({ success: false, message: 'Task not found' });

    const key = task.type === 'daily' ? `${task.id}_${todayKeyIST()}` : task.id;
    const claimed = Array.isArray(user.claimedTasks) ? user.claimedTasks : [];
    if (claimed.includes(key)) return res.json({ success: false, message: 'Already claimed' });
    if (task.progress < task.count) return res.json({ success: false, message: `Progress ${task.progress}/${task.count}` });

    await db.collection(COL.USERS).doc(user.id).update({
      withdrawalBalance: round2(Number(user.withdrawalBalance || 0) + task.reward),
      claimedTasks: [...claimed, key]
    });
    await addBill(user.id, 'Bonus (Task)', `+₹${task.reward.toFixed(2)}`, 'Success');
    res.json({ success: true, reward: task.reward, message: `₹${task.reward} claimed!` });
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

// Bills, Live Sync, Promo, Blog, Tickets, Notices
app.get('/api/bills/:uid', async (req, res) => {
  try {
    const snap = await db.collection(COL.BILLS).where('userId', '==', String(req.params.uid)).get();
    const bills = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, bills });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/live-sync/:uid', async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const user = await getUserById(uid);
    if (!user) return res.json({ success: false, message: 'User not found' });

    const [products, ordersSnap, ticketsSnap, noticesSnap, config, team] = await Promise.all([
      getAllProducts(),
      db.collection(COL.ORDERS).where('userId', '==', uid).get(),
      db.collection(COL.TICKETS).where('userId', '==', uid).get(),
      db.collection(COL.NOTICES).get(),
      getConfig(),
      getTeamSummary(user)
    ]);

    const myProducts = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const tickets = ticketsSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const notices = noticesSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

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

app.post('/api/promo/claim', async (req, res) => {
  try {
    const { userId, code } = req.body || {};
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return res.json({ success: false, message: 'Enter promo code' });

    const promoRef = db.collection(COL.PROMOS).doc(clean);
    const userRef = db.collection(COL.USERS).doc(String(userId));

    const outcome = await db.runTransaction(async (tx) => {
      const [pSnap, uSnap] = await Promise.all([tx.get(promoRef), tx.get(userRef)]);
      if (!pSnap.exists || pSnap.data().active === false) return { ok: false, message: 'Invalid promo code' };
      if (!uSnap.exists) return { ok: false, message: 'User not found' };

      const promo = pSnap.data();
      const user = uSnap.data();
      if (promo.maxUses && Number(promo.usedCount || 0) >= Number(promo.maxUses)) {
        return { ok: false, message: 'Promo limit reached' };
      }
      const claimed = Array.isArray(user.claimedPromos) ? user.claimedPromos : [];
      if (claimed.includes(clean)) return { ok: false, message: 'Already claimed' };

      const reward = round2(promo.reward || 0);
      tx.update(userRef, {
        withdrawalBalance: round2(Number(user.withdrawalBalance || 0) + reward),
        claimedPromos: [...claimed, clean]
      });
      tx.update(promoRef, { usedCount: Number(promo.usedCount || 0) + 1 });
      return { ok: true, reward };
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });
    await addBill(userId, 'Promo', `+₹${outcome.reward.toFixed(2)}`, 'Success', { code: clean });
    res.json({ success: true, message: `₹${outcome.reward} added to withdrawal balance!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/blog/list', async (req, res) => {
  try {
    const snap = await db.collection(COL.BLOG).get();
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/blog/submit', async (req, res) => {
  try {
    const { userId, text, images } = req.body || {};
    const id = genId('POST');
    const post = {
      id,
      userId: String(userId || 'Guest'),
      text: String(text || '').trim(),
      images: Array.isArray(images) ? images.filter(Boolean).slice(0, 2) : [],
      createdAt: new Date().toISOString()
    };
    await db.collection(COL.BLOG).doc(id).set(post);
    res.json({ success: true, post });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/service/ticket', async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    const id = genId('TKT');
    const ticket = {
      id,
      userId: String(userId || 'Guest'),
      message: String(message || '').trim(),
      status: 'Open',
      adminReply: '',
      createdAt: new Date().toISOString()
    };
    await db.collection(COL.TICKETS).doc(id).set(ticket);
    res.json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/notices', async (req, res) => {
  try {
    const snap = await db.collection(COL.NOTICES).get();
    const notices = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, notices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 6. ADMIN PANEL ROUTES
// ============================================================================
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const [uSnap, oSnap, rSnap, wSnap, tSnap] = await Promise.all([
      db.collection(COL.USERS).get(),
      db.collection(COL.ORDERS).get(),
      db.collection(COL.RECHARGES).get(),
      db.collection(COL.WITHDRAWALS).get(),
      db.collection(COL.TICKETS).get()
    ]);

    const recharges = rSnap.docs.map(d => d.data());
    const withdrawals = wSnap.docs.map(d => d.data());

    res.json({
      success: true,
      stats: {
        totalUsers: uSnap.size,
        totalOrders: oSnap.size,
        pendingRecharges: recharges.filter(x => x.status === 'Pending').length,
        pendingWithdrawals: withdrawals.filter(x => x.status === 'Pending').length,
        openTickets: tSnap.docs.filter(x => x.data().status === 'Open').length,
        totalRechargeApproved: round2(recharges.filter(x => x.status === 'Success').reduce((s, x) => s + Number(x.amount || 0), 0)),
        totalWithdrawApproved: round2(withdrawals.filter(x => x.status === 'Success').reduce((s, x) => s + Number(x.amount || 0), 0))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/config', adminAuth, async (req, res) => {
  try {
    const patch = { ...(req.body || {}) };
    delete patch.adminKey;
    await db.collection(COL.META).doc('config').set(patch, { merge: true });
    const config = await getConfig();
    res.json({ success: true, config, message: 'Config updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.USERS).get();
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users/:uid', adminAuth, async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const patch = { ...(req.body || {}) };
    delete patch.adminKey;
    if (patch.totalInvestment !== undefined) {
      patch.vipLevel = calcVipLevel(patch.totalInvestment);
    }
    await db.collection(COL.USERS).doc(uid).update(patch);
    const user = await getUserById(uid);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const id = b.id || genId('PROD');
    const product = {
      id,
      name: String(b.name || 'Growth Plan'),
      image: String(b.image || ''),
      vipLevel: Number(b.vipLevel || 0),
      price: Number(b.price || 100),
      dailyIncome: Number(b.dailyIncome || 10),
      durationDays: Number(b.durationDays || 30),
      isLimited: Boolean(b.isLimited),
      remainingCopies: Number(b.remainingCopies || 0),
      totalCopies: Number(b.totalCopies || b.remainingCopies || 0),
      soldOut: Boolean(b.soldOut),
      soldOutMessage: String(b.soldOutMessage || 'Product khatam ho gaya hai koi or product buy karo thank you')
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

app.get('/api/admin/recharges', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.RECHARGES).get();
    const recharges = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, recharges });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/recharges/:id/action', adminAuth, async (req, res) => {
  try {
    const { action } = req.body || {};
    const rRef = db.collection(COL.RECHARGES).doc(String(req.params.id));

    const outcome = await db.runTransaction(async (tx) => {
      const rSnap = await tx.get(rRef);
      if (!rSnap.exists) return { ok: false, message: 'Recharge not found' };
      const rec = rSnap.data();
      if (rec.status === 'Success' || rec.status === 'Rejected') return { ok: false, message: `Already ${rec.status}` };

      if (action === 'approve') {
        const uRef = db.collection(COL.USERS).doc(String(rec.userId));
        const uSnap = await tx.get(uRef);
        if (!uSnap.exists) return { ok: false, message: 'User not found' };
        const u = uSnap.data();
        const amt = round2(rec.amount);
        tx.update(uRef, {
          chargedBalance: round2(Number(u.chargedBalance || 0) + amt),
          totalRecharge: round2(Number(u.totalRecharge || 0) + amt)
        });
        tx.update(rRef, { status: 'Success', approvedAt: new Date().toISOString() });
        return { ok: true, status: 'Success', rec };
      } else {
        tx.update(rRef, { status: 'Rejected', rejectedAt: new Date().toISOString() });
        return { ok: true, status: 'Rejected', rec };
      }
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    const bSnap = await db.collection(COL.BILLS).where('orderId', '==', outcome.rec.id).limit(1).get();
    if (!bSnap.empty) await bSnap.docs[0].ref.update({ status: outcome.status });

    res.json({ success: true, status: outcome.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.WITHDRAWALS).get();
    const withdrawals = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/withdrawals/:id/action', adminAuth, async (req, res) => {
  try {
    const { action } = req.body || {};
    const wRef = db.collection(COL.WITHDRAWALS).doc(String(req.params.id));

    const outcome = await db.runTransaction(async (tx) => {
      const wSnap = await tx.get(wRef);
      if (!wSnap.exists) return { ok: false, message: 'Withdrawal not found' };
      const wd = wSnap.data();
      if (wd.status === 'Success' || wd.status === 'Rejected') return { ok: false, message: `Already ${wd.status}` };

      if (action === 'approve') {
        tx.update(wRef, { status: 'Success', approvedAt: new Date().toISOString() });
        return { ok: true, status: 'Success', wd };
      } else {
        const uRef = db.collection(COL.USERS).doc(String(wd.userId));
        const uSnap = await tx.get(uRef);
        if (uSnap.exists) {
          const u = uSnap.data();
          const amt = round2(wd.amount);
          tx.update(uRef, {
            withdrawalBalance: round2(Number(u.withdrawalBalance || 0) + amt),
            totalWithdraw: Math.max(0, round2(Number(u.totalWithdraw || 0) - amt))
          });
        }
        tx.update(wRef, { status: 'Rejected', rejectedAt: new Date().toISOString() });
        return { ok: true, status: 'Rejected', wd };
      }
    });

    if (!outcome.ok) return res.json({ success: false, message: outcome.message });

    const bSnap = await db.collection(COL.BILLS).where('withdrawalId', '==', outcome.wd.id).limit(1).get();
    if (!bSnap.empty) await bSnap.docs[0].ref.update({ status: outcome.status });

    res.json({ success: true, status: outcome.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/promos', adminAuth, async (req, res) => {
  try {
    const { code, reward, maxUses = 1000 } = req.body || {};
    const clean = String(code || '').trim().toUpperCase();
    if (!clean || !reward) return res.json({ success: false, message: 'Code and reward required' });
    const promo = { code: clean, reward: round2(reward), maxUses: Number(maxUses), usedCount: 0, active: true, createdAt: new Date().toISOString() };
    await db.collection(COL.PROMOS).doc(clean).set(promo);
    res.json({ success: true, promo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/notices', adminAuth, async (req, res) => {
  try {
    const { title, summary, content, icon = 'bell' } = req.body || {};
    const id = genId('NTC');
    const notice = { id, icon, title: String(title || 'Notice'), summary: String(summary || ''), content: String(content || ''), date: todayKeyIST(), createdAt: new Date().toISOString() };
    await db.collection(COL.NOTICES).doc(id).set(notice);
    res.json({ success: true, notice });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/tickets', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection(COL.TICKETS).get();
    const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
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
// 7. 404 & STARTUP
// ============================================================================
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

seedDefaults()
  .then(() => {
    processDailyOrderReturns();
    setInterval(processDailyOrderReturns, 30 * 60 * 1000);
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT} for project firegan-c593c`);
    });
  })
  .catch((err) => {
    console.error('Firebase startup error:', err.message);
    process.exit(1);
  });
