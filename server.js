const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// ============================================================================
// 1. FIREBASE ADMIN INITIALIZATION (FAST & SAFE)
// ============================================================================
function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  let serviceAccount = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      console.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
    }
  }

  if (!serviceAccount && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }

  if (!serviceAccount) {
    try {
      serviceAccount = require('./serviceAccountKey.json');
    } catch (_) {}
  }

  if (serviceAccount) {
    if (serviceAccount.private_key && !serviceAccount.privateKey) {
      serviceAccount.privateKey = serviceAccount.private_key;
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
  }

  return admin.firestore();
}

const db = initFirebase();
const FieldValue = admin.firestore.FieldValue;

// ============================================================================
// 2. FAST CACHE + HELPERS + ADMIN AUTH
// ============================================================================
const PORT = Number(process.env.PORT || 8000);
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || 'GW_ADMIN_9090').trim();

const cache = {
  products: null,
  productsTs: 0,
  config: null,
  configTs: 0,
  banners: null,
  bannersTs: 0
};

function invalidateProductsCache() {
  cache.products = null;
  cache.productsTs = 0;
}

function invalidateConfigCache() {
  cache.config = null;
  cache.configTs = 0;
  cache.banners = null;
  cache.bannersTs = 0;
}

function requireAdmin(req, res, next) {
  const provided = String(
    req.headers['x-admin-key'] ||
    req.query.adminKey ||
    req.body?.adminKey ||
    ''
  ).trim();

  if (!provided || provided !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid Admin Key' });
  }
  next();
}

function docsToArray(snap) {
  const out = [];
  snap.forEach((doc) => out.push({ id: doc.id, ...doc.data() }));
  return out;
}

function isOversizedImage(str) {
  return typeof str === 'string' && str.length > 1800000;
}

function hashPassword(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function sanitizeUser(id, u = {}) {
  return {
    id,
    phone: u.phone || '',
    realName: u.real_name || '',
    chargedBalance: Number(u.charged_balance || 0),
    withdrawalBalance: Number(u.withdrawal_balance || 0),
    totalInvestment: Number(u.total_investment || 0),
    totalRecharge: Number(u.total_recharge || 0),
    totalWithdraw: Number(u.total_withdraw || 0),
    vipLevel: Number(u.vip_level || 0),
    ownInviteCode: u.own_invite_code || ('GW' + id),
    invitedBy: u.invited_by || null,
    upiId: u.saved_upi_id || u.upi_id || '',
    savedUpiId: u.saved_upi_id || u.upi_id || '',
    createdAt: u.created_at || null
  };
}

function getCycleMs(unit = 'day') {
  const u = String(unit || 'day').toLowerCase();
  if (u === 'minute' || u === 'min' || u === '1m') return 60 * 1000;
  if (u === 'hour' || u === 'hr' || u === '1h') return 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function normalizeCycleUnit(unit = 'day') {
  const u = String(unit || 'day').toLowerCase();
  if (u === 'minute' || u === 'min' || u === '1m') return 'minute';
  if (u === 'hour' || u === 'hr' || u === '1h') return 'hour';
  return 'day';
}

function formatProduct(p = {}) {
  const unit = normalizeCycleUnit(p.cycle_unit || p.cycleUnit || 'day');
  const dur = Number(p.duration_days ?? p.durationDays ?? 1);
  const daily = Number(p.daily_income ?? p.dailyIncome ?? 0);
  const rem = Number(p.remaining_copies ?? p.remainingCopies ?? 9999);
  const img = String(p.image || p.image_url || p.imageUrl || '');
  return {
    id: p.id,
    name: p.name,
    image: img,
    imageUrl: img,
    image_url: img,
    price: Number(p.price || 0),
    dailyIncome: daily,
    daily_income: daily,
    durationDays: dur,
    duration_days: dur,
    cycleUnit: unit,
    cycle_unit: unit,
    vipLevel: Number(p.vip_level ?? p.vipLevel ?? 0),
    vip_level: Number(p.vip_level ?? p.vipLevel ?? 0),
    isLimited: Boolean(p.is_limited ?? p.isLimited),
    remainingCopies: rem,
    soldOut: Boolean(p.is_limited ?? p.isLimited) && rem <= 0,
    totalReturn: daily * dur
  };
}

async function getAppConfigDoc(force = false) {
  if (!force && cache.config && Date.now() - cache.configTs < 15000) {
    return cache.config;
  }
  const ref = db.collection('app_config').doc('1');
  const snap = await ref.get();
  const defaults = {
    brandName: 'GROWTHWAVE CAPITAL',
    upiId: 'growthwave@upi',
    whatsappNumber: '',
    supportHours: '24/7 Live Assistance',
    popupBanner: {
      enabled: false,
      title: 'Welcome to GrowthWave',
      message: 'Explore flexible minute, hourly & daily investment plans.',
      imageUrl: '',
      buttonText: 'Explore Plans',
      targetPage: 'invest'
    }
  };
  let merged = defaults;
  if (!snap.exists) {
    await ref.set({ data: defaults });
  } else {
    const saved = snap.data()?.data || {};
    merged = {
      ...defaults,
      ...saved,
      popupBanner: { ...defaults.popupBanner, ...(saved.popupBanner || {}) }
    };
  }
  cache.config = merged;
  cache.configTs = Date.now();
  return merged;
}

async function getActiveBanners(force = false) {
  if (!force && cache.banners && Date.now() - cache.bannersTs < 15000) {
    return cache.banners;
  }
  const snap = await db.collection('banners').get();
  const list = docsToArray(snap)
    .filter((b) => b.active !== false)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  cache.banners = list;
  cache.bannersTs = Date.now();
  return list;
}

async function getAllProductsFast(force = false) {
  if (!force && cache.products && Date.now() - cache.productsTs < 10000) {
    return cache.products;
  }
  const snap = await db.collection('products').get();
  const list = docsToArray(snap).map(formatProduct);
  cache.products = list;
  cache.productsTs = Date.now();
  return list;
}

async function seedDefaultsIfEmpty() {
  const prodSnap = await db.collection('products').limit(1).get();
  if (prodSnap.empty) {
    const starterPlans = [
      {
        id: 'PLAN_1M',
        name: 'Flash 1-Min Pass',
        image: '',
        imageUrl: '',
        image_url: '',
        price: 100,
        daily_income: 5,
        duration_days: 10,
        cycle_unit: 'minute',
        vip_level: 0,
        is_limited: false,
        remaining_copies: 9999
      },
      {
        id: 'PLAN_1H',
        name: 'Hourly Yield Node',
        image: '',
        imageUrl: '',
        image_url: '',
        price: 300,
        daily_income: 18,
        duration_days: 24,
        cycle_unit: 'hour',
        vip_level: 1,
        is_limited: false,
        remaining_copies: 9999
      },
      {
        id: 'PLAN_1D',
        name: 'Daily Growth Vault',
        image: '',
        imageUrl: '',
        image_url: '',
        price: 580,
        daily_income: 45,
        duration_days: 30,
        cycle_unit: 'day',
        vip_level: 1,
        is_limited: false,
        remaining_copies: 9999
      }
    ];
    const batch = db.batch();
    for (const p of starterPlans) {
      batch.set(db.collection('products').doc(p.id), p);
    }
    await batch.commit();
    invalidateProductsCache();
  }
}

// ============================================================================
// 3. HEALTH & PUBLIC CONFIG ROUTES
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'GrowthWave Capital API',
    status: 'online',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, ok: true, ts: Date.now() });
});

app.get('/api/config', async (req, res) => {
  try {
    const [config, banners] = await Promise.all([getAppConfigDoc(), getActiveBanners()]);
    res.json({ success: true, config, banners, popupBanner: config.popupBanner });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/banners', async (req, res) => {
  try {
    const [banners, config] = await Promise.all([getActiveBanners(), getAppConfigDoc()]);
    res.json({ success: true, banners, popupBanner: config.popupBanner });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/service/support-info', async (req, res) => {
  try {
    const cfg = await getAppConfigDoc();
    const cleanPhone = String(cfg.whatsappNumber || '').replace(/[^\d]/g, '');
    res.json({
      success: true,
      supportHours: cfg.supportHours || '24/7 Live Assistance',
      whatsappUrl: cleanPhone ? `https://wa.me/${cleanPhone}` : null,
      quickReplies: [
        'Recharge UTR verify kab hoga?',
        'Withdrawal status update chahiye',
        '1m / 1h / daily plan payout kaise milta hai?',
        'Permanent UPI ID kaise set karein?'
      ]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 4. AUTH & PERMANENT UPI PROFILE ROUTES
// ============================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, withdrawPassword, inviteCode, realName, upiId } = req.body || {};
    const cleanPhone = String(phone || '').trim();
    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });
    }
    if (!password || String(password).length < 4) {
      return res.status(400).json({ success: false, message: 'Login password must be at least 4 characters' });
    }
    if (!withdrawPassword || String(withdrawPassword).length < 4) {
      return res.status(400).json({ success: false, message: 'Withdrawal password must be at least 4 characters' });
    }

    const existing = await db.collection('users').where('phone', '==', cleanPhone).limit(1).get();
    if (!existing.empty) {
      return res.status(400).json({ success: false, message: 'Mobile number already registered' });
    }

    let inviterId = null;
    const cleanInvite = String(inviteCode || '').trim().toUpperCase();
    if (cleanInvite && cleanInvite !== 'NONE') {
      const refSnap = await db.collection('users').where('own_invite_code', '==', cleanInvite).limit(1).get();
      if (!refSnap.empty) inviterId = refSnap.docs[0].id;
    }

    const counterRef = db.collection('counters').doc('users');
    const userId = await db.runTransaction(async (t) => {
      const cDoc = await t.get(counterRef);
      const nextNum = (cDoc.exists ? Number(cDoc.data().seq || 10000) : 10000) + 1;
      t.set(counterRef, { seq: nextNum }, { merge: true });
      const uid = String(nextNum);
      const ownCode = 'GW' + uid;
      const cleanUpi = String(upiId || '').trim();

      t.set(db.collection('users').doc(uid), {
        id: uid,
        phone: cleanPhone,
        real_name: String(realName || '').trim(),
        password_hash: hashPassword(password),
        withdraw_password_hash: hashPassword(withdrawPassword),
        charged_balance: 0,
        withdrawal_balance: 0,
        total_investment: 0,
        total_recharge: 0,
        total_withdraw: 0,
        vip_level: 0,
        own_invite_code: ownCode,
        invited_by: inviterId,
        saved_upi_id: cleanUpi,
        upi_id: cleanUpi,
        created_at: new Date().toISOString()
      });
      return uid;
    });

    const userDoc = await db.collection('users').doc(userId).get();
    res.json({
      success: true,
      userId,
      message: 'Account created successfully',
      user: sanitizeUser(userId, userDoc.data())
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password are required' });
    }

    const snap = await db.collection('users').where('phone', '==', cleanPhone).limit(1).get();
    if (snap.empty) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.password_hash !== hashPassword(password)) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    res.json({
      success: true,
      userId: doc.id,
      message: 'Login successful',
      user: sanitizeUser(doc.id, data)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/upi/save', async (req, res) => {
  try {
    const { userId, upiId } = req.body || {};
    const cleanUpi = String(upiId || '').trim();
    if (!userId || !cleanUpi || !cleanUpi.includes('@')) {
      return res.status(400).json({ success: false, message: 'Enter a valid UPI ID (e.g. name@upi)' });
    }
    const ref = db.collection('users').doc(String(userId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, message: 'User not found' });

    await ref.set({ saved_upi_id: cleanUpi, upi_id: cleanUpi }, { merge: true });
    res.json({ success: true, message: 'Permanent UPI ID saved', upiId: cleanUpi });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 5. LIVE SYNC, PRODUCTS & FLEXIBLE CYCLE ORDERS (1m / 1h / day)
// ============================================================================
app.get('/api/live-sync/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const [ordersSnap, ticketsSnap, config, banners] = await Promise.all([
      db.collection('user_orders').where('user_id', '==', userId).get(),
      db.collection('support_tickets').where('user_id', '==', userId).get(),
      getAppConfigDoc(),
      getActiveBanners()
    ]);

    const myProducts = docsToArray(ordersSnap)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .map((o) => ({
        id: o.id,
        productId: o.product_id,
        productName: o.product_name,
        totalAmount: Number(o.total_amount || 0),
        dailyIncome: Number(o.daily_income || 0),
        durationDays: Number(o.duration_days || 1),
        cycleUnit: normalizeCycleUnit(o.cycle_unit || 'day'),
        claimedCycles: Number(o.claimed_cycles || 0),
        lastClaimAt: o.last_claim_at || null,
        status: o.status || 'Active',
        createdAt: o.created_at || null
      }));

    const tickets = docsToArray(ticketsSnap)
      .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
      .map((t) => ({
        id: t.id,
        userId: t.user_id,
        message: t.message,
        imageData: t.image_data || '',
        adminReply: t.admin_reply || '',
        createdAt: t.created_at || null
      }));

    res.json({
      success: true,
      user: sanitizeUser(userId, userSnap.data()),
      myProducts,
      tickets,
      config,
      banners,
      popupBanner: config.popupBanner
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    await seedDefaultsIfEmpty();
    const products = await getAllProductsFast();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/products/buy', async (req, res) => {
  try {
    const { userId, productId, copies = 1 } = req.body || {};
    const qty = Math.max(1, Number(copies || 1));
    if (!userId || !productId) {
      return res.status(400).json({ success: false, message: 'userId and productId are required' });
    }

    const result = await db.runTransaction(async (t) => {
      const uRef = db.collection('users').doc(String(userId));
      const pRef = db.collection('products').doc(String(productId));
      const [uSnap, pSnap] = await Promise.all([t.get(uRef), t.get(pRef)]);

      if (!uSnap.exists) throw new Error('User not found');
      if (!pSnap.exists) throw new Error('Investment plan not found');

      const uData = uSnap.data();
      const pData = pSnap.data();
      const price = Number(pData.price || 0) * qty;
      const dailyIncome = Number(pData.daily_income || 0) * qty;
      const durationCycles = Math.max(1, Number(pData.duration_days || 1));
      const cycleUnit = normalizeCycleUnit(pData.cycle_unit || 'day');
      const charged = Number(uData.charged_balance || 0);

      if (charged < price) {
        throw new Error(`Insufficient Charged Balance (Need ₹${price}, Available ₹${charged.toFixed(2)})`);
      }

      if (pData.is_limited && Number(pData.remaining_copies || 0) < qty) {
        throw new Error('Plan sold out');
      }

      const newInvest = Number(uData.total_investment || 0) + price;
      const newVip = Math.max(Number(uData.vip_level || 0), Number(pData.vip_level || 0));

      t.update(uRef, {
        charged_balance: charged - price,
        total_investment: newInvest,
        vip_level: newVip
      });

      if (pData.is_limited) {
        t.update(pRef, {
          remaining_copies: Number(pData.remaining_copies || 0) - qty
        });
      }

      const orderId = 'ORD' + Date.now();
      const nowIso = new Date().toISOString();
      t.set(db.collection('user_orders').doc(orderId), {
        id: orderId,
        user_id: String(userId),
        product_id: String(productId),
        product_name: pData.name,
        total_amount: price,
        daily_income: dailyIncome,
        duration_days: durationCycles,
        cycle_unit: cycleUnit,
        claimed_cycles: 0,
        last_claim_at: null,
        status: 'Active',
        created_at: nowIso
      });

      const txId = 'TX' + Date.now();
      t.set(db.collection('transactions').doc(txId), {
        id: txId,
        user_id: String(userId),
        type: 'Investment',
        amount: `-₹${price.toFixed(2)}`,
        raw_amount: price,
        status: 'Approved',
        tx_ref: orderId,
        created_at: nowIso
      });

      return { orderId, productName: pData.name, price, cycleUnit, durationCycles };
    });

    invalidateProductsCache();
    res.json({
      success: true,
      orderId: result.orderId,
      message: `${result.productName} activated (₹${result.price}, every ${result.cycleUnit} for ${result.durationCycles} cycles)`
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/orders/claim-income', async (req, res) => {
  try {
    const { userId, orderId } = req.body || {};
    if (!userId || !orderId) {
      return res.status(400).json({ success: false, message: 'userId and orderId required' });
    }

    const payout = await db.runTransaction(async (t) => {
      const oRef = db.collection('user_orders').doc(String(orderId));
      const uRef = db.collection('users').doc(String(userId));
      const [oSnap, uSnap] = await Promise.all([t.get(oRef), t.get(uRef)]);

      if (!oSnap.exists) throw new Error('Order not found');
      if (!uSnap.exists) throw new Error('User not found');

      const o = oSnap.data();
      if (String(o.user_id) !== String(userId)) throw new Error('Order does not belong to user');

      const unit = normalizeCycleUnit(o.cycle_unit || 'day');
      const cycleMs = getCycleMs(unit);
      const maxCycles = Math.max(1, Number(o.duration_days || 1));
      const claimedCycles = Number(o.claimed_cycles || 0);

      if (claimedCycles >= maxCycles || o.status === 'Completed') {
        t.update(oRef, { status: 'Completed' });
        throw new Error('All payout cycles already completed for this order');
      }

      if (o.last_claim_at) {
        const elapsed = Date.now() - new Date(o.last_claim_at).getTime();
        if (elapsed < cycleMs) {
          const remSec = Math.ceil((cycleMs - elapsed) / 1000);
          throw new Error(`Next ${unit} payout ready in ${remSec}s`);
        }
      }

      const amt = Number(o.daily_income || 0);
      const nextClaimed = claimedCycles + 1;
      const nextStatus = nextClaimed >= maxCycles ? 'Completed' : 'Active';

      t.update(oRef, {
        claimed_cycles: nextClaimed,
        last_claim_at: new Date().toISOString(),
        status: nextStatus
      });

      t.update(uRef, {
        withdrawal_balance: Number(uSnap.data().withdrawal_balance || 0) + amt
      });

      const txId = 'CLM' + Date.now();
      t.set(db.collection('transactions').doc(txId), {
        id: txId,
        user_id: String(userId),
        type: 'Income Claim',
        amount: `+₹${amt.toFixed(2)}`,
        raw_amount: amt,
        status: 'Approved',
        tx_ref: String(orderId),
        created_at: new Date().toISOString()
      });

      return { amt, nextClaimed, maxCycles, unit };
    });

    res.json({
      success: true,
      message: `Claimed ₹${payout.amt.toFixed(2)} (${payout.unit} cycle ${payout.nextClaimed}/${payout.maxCycles})`
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 6. RECHARGE, WITHDRAW & BILLS
// ============================================================================
app.post('/api/recharge/create', async (req, res) => {
  try {
    const { userId, amount, channel = 'UPI' } = req.body || {};
    const amt = Number(amount);
    if (!userId || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'Valid userId and amount required' });
    }
    const orderId = 'RCH' + Date.now();
    await db.collection('transactions').doc(orderId).set({
      id: orderId,
      user_id: String(userId),
      type: 'Recharge',
      amount: `+₹${amt.toFixed(2)}`,
      raw_amount: amt,
      channel: String(channel || 'UPI'),
      status: 'Pending',
      tx_ref: '',
      created_at: new Date().toISOString()
    });
    res.json({ success: true, orderId, amount: amt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/recharge/verify', async (req, res) => {
  try {
    const { userId, amount, razorpay_order_id, utr } = req.body || {};
    const cleanUtr = String(utr || '').trim();
    if (!userId || !cleanUtr) {
      return res.status(400).json({ success: false, message: 'UTR number is required' });
    }

    const orderId = String(razorpay_order_id || ('RCH' + Date.now()));
    const ref = db.collection('transactions').doc(orderId);
    const snap = await ref.get();

    if (snap.exists) {
      await ref.update({
        tx_ref: cleanUtr,
        status: 'Pending',
        updated_at: new Date().toISOString()
      });
    } else {
      const amt = Number(amount || 0);
      await ref.set({
        id: orderId,
        user_id: String(userId),
        type: 'Recharge',
        amount: `+₹${amt.toFixed(2)}`,
        raw_amount: amt,
        status: 'Pending',
        tx_ref: cleanUtr,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, message: 'UTR submitted for admin verification' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/withdraw/auto-upi', async (req, res) => {
  try {
    const {
      userId,
      amount,
      holderName = '',
      bankName = '',
      accountNumber = '',
      ifsc = '',
      upiId = '',
      withdrawPassword = ''
    } = req.body || {};

    const amt = Number(amount);
    if (!userId || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'Valid withdrawal amount required' });
    }

    const cleanUpi = String(upiId || '').trim();

    const txId = await db.runTransaction(async (t) => {
      const uRef = db.collection('users').doc(String(userId));
      const uSnap = await t.get(uRef);
      if (!uSnap.exists) throw new Error('User not found');

      const u = uSnap.data();
      if (u.withdraw_password_hash && u.withdraw_password_hash !== hashPassword(withdrawPassword)) {
        throw new Error('Invalid withdrawal password');
      }

      const bal = Number(u.withdrawal_balance || 0);
      if (bal < amt) {
        throw new Error(`Insufficient Withdrawal Balance (Available ₹${bal.toFixed(2)})`);
      }

      const userUpdate = { withdrawal_balance: bal - amt };
      if (cleanUpi && cleanUpi.includes('@')) {
        userUpdate.saved_upi_id = cleanUpi;
        userUpdate.upi_id = cleanUpi;
      }
      t.update(uRef, userUpdate);

      const id = 'WDR' + Date.now();
      t.set(db.collection('transactions').doc(id), {
        id,
        user_id: String(userId),
        type: 'Withdrawal',
        amount: `-₹${amt.toFixed(2)}`,
        raw_amount: amt,
        status: 'Pending',
        meta: {
          realName: String(holderName || u.real_name || '').trim(),
          bankName: String(bankName || '').trim(),
          bankAccount: String(accountNumber || '').trim(),
          ifsc: String(ifsc || '').trim().toUpperCase(),
          upiId: cleanUpi || String(u.saved_upi_id || u.upi_id || '').trim()
        },
        created_at: new Date().toISOString()
      });

      return id;
    });

    res.json({ success: true, txId, message: `Withdrawal request ₹${amt.toFixed(2)} submitted` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/bills/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const snap = await db.collection('transactions').where('user_id', '==', userId).get();
    const bills = docsToArray(snap)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .map((b) => ({
        id: b.id,
        type: b.type,
        amount: b.amount,
        rawAmount: Number(b.raw_amount || 0),
        status: b.status,
        txRef: b.tx_ref || '',
        createdAt: b.created_at || null
      }));
    res.json({ success: true, bills });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 7. CHECK-IN, TASKS, TEAM, LOW-AMOUNT SPIN & PROMO CODES
// ============================================================================
app.get('/api/checkin/status/:userId', async (req, res) => {
  try {
    const uid = String(req.params.userId);
    const snap = await db.collection('checkins').doc(uid).get();
    const data = snap.exists ? snap.data() : {};
    const todayKey = new Date().toISOString().slice(0, 10);
    res.json({
      success: true,
      claimedToday: data.last_date === todayKey,
      streak: Number(data.streak || 0),
      nextReward: 10
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/checkin/claim', async (req, res) => {
  try {
    const uid = String(req.body?.userId || '');
    if (!uid) return res.status(400).json({ success: false, message: 'userId required' });
    const todayKey = new Date().toISOString().slice(0, 10);

    await db.runTransaction(async (t) => {
      const cRef = db.collection('checkins').doc(uid);
      const uRef = db.collection('users').doc(uid);
      const [cSnap, uSnap] = await Promise.all([t.get(cRef), t.get(uRef)]);
      if (!uSnap.exists) throw new Error('User not found');
      const cData = cSnap.exists ? cSnap.data() : {};
      if (cData.last_date === todayKey) throw new Error('Already claimed daily check-in today');

      t.set(cRef, { last_date: todayKey, streak: Number(cData.streak || 0) + 1 }, { merge: true });
      t.update(uRef, { withdrawal_balance: Number(uSnap.data().withdrawal_balance || 0) + 10 });
    });

    res.json({ success: true, message: 'Daily check-in bonus ₹10 credited!' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/tasks/:userId', async (req, res) => {
  try {
    const uid = String(req.params.userId);
    const [uSnap, claimedSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('user_tasks').where('user_id', '==', uid).get()
    ]);
    const u = uSnap.exists ? uSnap.data() : {};
    const claimedSet = new Set(docsToArray(claimedSnap).map((x) => x.task_id));
    const invest = Number(u.total_investment || 0);

    res.json({
      success: true,
      tasks: [
        {
          id: 'TSK_FIRST_INV',
          title: 'First Investment Starter',
          description: 'Invest ₹100 or more in any plan',
          reward: 20,
          progress: Math.min(invest, 100),
          target: 100,
          eligible: invest >= 100,
          claimed: claimedSet.has('TSK_FIRST_INV')
        },
        {
          id: 'TSK_GROWTH_500',
          title: 'Portfolio Builder',
          description: 'Reach ₹500 total active investment',
          reward: 50,
          progress: Math.min(invest, 500),
          target: 500,
          eligible: invest >= 500,
          claimed: claimedSet.has('TSK_GROWTH_500')
        }
      ]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/tasks/claim', async (req, res) => {
  try {
    const { userId, taskId } = req.body || {};
    if (!userId || !taskId) return res.status(400).json({ success: false, message: 'userId and taskId required' });

    const rewardMap = { TSK_FIRST_INV: { minInv: 100, amt: 20 }, TSK_GROWTH_500: { minInv: 500, amt: 50 } };
    const cfg = rewardMap[String(taskId)];
    if (!cfg) return res.status(400).json({ success: false, message: 'Invalid task' });

    const docId = `${userId}_${taskId}`;
    await db.runTransaction(async (t) => {
      const tRef = db.collection('user_tasks').doc(docId);
      const uRef = db.collection('users').doc(String(userId));
      const [tSnap, uSnap] = await Promise.all([t.get(tRef), t.get(uRef)]);
      if (tSnap.exists) throw new Error('Task already claimed');
      if (!uSnap.exists) throw new Error('User not found');
      if (Number(uSnap.data().total_investment || 0) < cfg.minInv) {
        throw new Error('Investment target not completed yet');
      }
      t.set(tRef, { user_id: String(userId), task_id: String(taskId), claimed_at: new Date().toISOString() });
      t.update(uRef, { withdrawal_balance: Number(uSnap.data().withdrawal_balance || 0) + cfg.amt });
    });

    res.json({ success: true, message: `Task reward ₹${cfg.amt} credited!` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/team/:userId', async (req, res) => {
  try {
    const uid = String(req.params.userId);
    const l1Snap = await db.collection('users').where('invited_by', '==', uid).get();
    const l1Ids = l1Snap.docs.map((d) => d.id);

    let l2Ids = [];
    if (l1Ids.length) {
      const l2Snap = await db.collection('users').where('invited_by', 'in', l1Ids.slice(0, 10)).get();
      l2Ids = l2Snap.docs.map((d) => d.id);
    }

    res.json({
      success: true,
      summary: {
        level1: l1Ids.length,
        level2: l2Ids.length,
        level3: 0,
        totalMembers: l1Ids.length + l2Ids.length,
        estimatedCommission: 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/wheel/spin', async (req, res) => {
  try {
    const uid = String(req.body?.userId || '');
    if (!uid) return res.status(400).json({ success: false, message: 'userId required' });

    const todayKey = new Date().toISOString().slice(0, 10);
    const pool = [
      { amount: 1, label: '₹1', weight: 35 },
      { amount: 2, label: '₹2', weight: 25 },
      { amount: 3, label: '₹3', weight: 18 },
      { amount: 5, label: '₹5', weight: 12 },
      { amount: 8, label: '₹8', weight: 5 },
      { amount: 10, label: '₹10', weight: 3 },
      { amount: 15, label: '₹15', weight: 1.5 },
      { amount: 25, label: '₹25', weight: 0.5 }
    ];
    const totalW = pool.reduce((s, x) => s + x.weight, 0);
    let r = Math.random() * totalW;
    let picked = pool[0];
    for (const item of pool) {
      r -= item.weight;
      if (r <= 0) { picked = item; break; }
    }

    await db.runTransaction(async (t) => {
      const sRef = db.collection('wheel_spins').doc(`${uid}_${todayKey}`);
      const uRef = db.collection('users').doc(uid);
      const [sSnap, uSnap] = await Promise.all([t.get(sRef), t.get(uRef)]);
      if (sSnap.exists) throw new Error('Daily spin already used today');
      if (!uSnap.exists) throw new Error('User not found');

      t.set(sRef, { user_id: uid, date: todayKey, amount: picked.amount, created_at: new Date().toISOString() });
      t.update(uRef, { withdrawal_balance: Number(uSnap.data().withdrawal_balance || 0) + picked.amount });
    });

    res.json({
      success: true,
      prize: { amount: picked.amount, label: picked.label },
      message: `Lucky Spin won ${picked.label}!`
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/promo/claim', async (req, res) => {
  try {
    const { userId, code } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!userId || !cleanCode) return res.status(400).json({ success: false, message: 'Code is required' });

    const claimed = await db.runTransaction(async (t) => {
      const pRef = db.collection('promo_codes').doc(cleanCode);
      const cRef = db.collection('promo_claims').doc(`${userId}_${cleanCode}`);
      const uRef = db.collection('users').doc(String(userId));
      const [pSnap, cSnap, uSnap] = await Promise.all([t.get(pRef), t.get(cRef), t.get(uRef)]);

      if (!pSnap.exists) throw new Error('Invalid promo code');
      if (cSnap.exists) throw new Error('Promo code already redeemed');
      if (!uSnap.exists) throw new Error('User not found');

      const pData = pSnap.data();
      const reward = Number(pData.reward || 0);
      const wallet = pData.wallet === 'withdrawal' ? 'withdrawal_balance' : 'charged_balance';

      t.set(cRef, { user_id: String(userId), code: cleanCode, claimed_at: new Date().toISOString() });
      t.update(uRef, { [wallet]: Number(uSnap.data()[wallet] || 0) + reward });
      return { reward, wallet };
    });

    res.json({
      success: true,
      message: `₹${claimed.reward} bonus credited to ${claimed.wallet === 'withdrawal_balance' ? 'Withdrawal' : 'Charged'} Wallet!`
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 8. COMMUNITY BLOG & CUSTOMER SUPPORT TICKETS
// ============================================================================
app.get('/api/blog/list', async (req, res) => {
  try {
    const snap = await db.collection('blog_posts').get();
    const posts = docsToArray(snap).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/blog/submit', async (req, res) => {
  try {
    const { userId, text = '', images = [] } = req.body || {};
    const safeImgs = Array.isArray(images) ? images.filter((x) => typeof x === 'string' && !isOversizedImage(x)).slice(0, 2) : [];
    if (!String(text || '').trim() && !safeImgs.length) {
      return res.status(400).json({ success: false, message: 'Text or photo is required' });
    }
    const id = 'BLG' + Date.now();
    const post = {
      id,
      userId: String(userId || ''),
      text: String(text || '').trim(),
      images: safeImgs,
      likes: 0,
      comments: [],
      createdAt: new Date().toISOString()
    };
    await db.collection('blog_posts').doc(id).set(post);
    res.json({ success: true, post });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/blog/:postId/like', async (req, res) => {
  try {
    await db.collection('blog_posts').doc(String(req.params.postId)).update({ likes: FieldValue.increment(1) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/service/ticket', async (req, res) => {
  try {
    const { userId, message = '', imageData = '' } = req.body || {};
    if (!userId || (!String(message || '').trim() && !imageData)) {
      return res.status(400).json({ success: false, message: 'Message or image is required' });
    }
    if (isOversizedImage(imageData)) return res.status(400).json({ success: false, message: 'Image size too large' });
    const id = 'TKT' + Date.now();
    const autoReply = 'Hello dear! What problem are you facing? Please tell us everything in detail.';
    await db.collection('support_tickets').doc(id).set({
      id,
      user_id: String(userId),
      message: String(message || '[Screenshot]').trim(),
      image_data: imageData || '',
      admin_reply: autoReply,
      replied_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    });
    res.json({ success: true, ticketId: id, reply: autoReply });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/service/ticket/:ticketId/reply', async (req, res) => {
  try {
    const { userId, message = '', imageData = '' } = req.body || {};
    const tRef = db.collection('support_tickets').doc(String(req.params.ticketId));
    const snap = await tRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const prev = snap.data();
    const appended = [prev.message, String(message || '[Screenshot]').trim()].filter(Boolean).join('\n');
    const autoReply = 'Hello dear! What problem are you facing? Please tell us everything in detail.';
    await tRef.update({
      user_id: String(userId || prev.user_id),
      message: appended,
      image_data: imageData || prev.image_data || '',
      admin_reply: autoReply,
      replied_at: new Date().toISOString()
    });
    res.json({ success: true, reply: autoReply });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 9. ADMIN PANEL ROUTES (PROTECTED BY GW_ADMIN_9090)
// ============================================================================
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const [usersSnap, txSnap, products, tktSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('transactions').get(),
      getAllProductsFast(true),
      db.collection('support_tickets').get()
    ]);

    const users = docsToArray(usersSnap);
    const transactions = docsToArray(txSnap).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const tickets = docsToArray(tktSnap).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    res.json({ success: true, users, transactions, products, tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/recharge/decide', requireAdmin, async (req, res) => {
  try {
    const { txId, action } = req.body || {};
    const act = String(action || '').toLowerCase();
    if (!txId || !['approve', 'reject'].includes(act)) {
      return res.status(400).json({ success: false, message: 'Invalid txId or action' });
    }

    await db.runTransaction(async (t) => {
      const txRef = db.collection('transactions').doc(String(txId));
      const txSnap = await t.get(txRef);
      if (!txSnap.exists) throw new Error('Transaction not found');
      const tx = txSnap.data();
      if (tx.status !== 'Pending') throw new Error('Transaction already processed');

      if (act === 'approve') {
        const uRef = db.collection('users').doc(String(tx.user_id));
        const uSnap = await t.get(uRef);
        if (!uSnap.exists) throw new Error('User not found');
        const amt = Number(tx.raw_amount || 0);
        t.update(uRef, {
          charged_balance: Number(uSnap.data().charged_balance || 0) + amt,
          total_recharge: Number(uSnap.data().total_recharge || 0) + amt
        });
        t.update(txRef, { status: 'Approved', decided_at: new Date().toISOString() });
      } else {
        t.update(txRef, { status: 'Rejected', decided_at: new Date().toISOString() });
      }
    });

    res.json({ success: true, message: `Recharge ${act}d` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/withdraw/decide', requireAdmin, async (req, res) => {
  try {
    const { txId, action } = req.body || {};
    const act = String(action || '').toLowerCase();
    if (!txId || !['approve', 'reject'].includes(act)) {
      return res.status(400).json({ success: false, message: 'Invalid txId or action' });
    }

    await db.runTransaction(async (t) => {
      const txRef = db.collection('transactions').doc(String(txId));
      const txSnap = await t.get(txRef);
      if (!txSnap.exists) throw new Error('Transaction not found');
      const tx = txSnap.data();
      if (tx.status !== 'Pending') throw new Error('Transaction already processed');

      const uRef = db.collection('users').doc(String(tx.user_id));
      const uSnap = await t.get(uRef);
      const amt = Number(tx.raw_amount || 0);

      if (act === 'approve') {
        if (uSnap.exists) {
          t.update(uRef, { total_withdraw: Number(uSnap.data().total_withdraw || 0) + amt });
        }
        t.update(txRef, { status: 'Approved', decided_at: new Date().toISOString() });
      } else {
        if (uSnap.exists) {
          t.update(uRef, { withdrawal_balance: Number(uSnap.data().withdrawal_balance || 0) + amt });
        }
        t.update(txRef, { status: 'Rejected', decided_at: new Date().toISOString() });
      }
    });

    res.json({ success: true, message: act === 'approve' ? 'Withdrawal approved' : 'Withdrawal rejected & refunded' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users/adjust-balance', requireAdmin, async (req, res) => {
  try {
    const { userId, field, delta } = req.body || {};
    const validField = field === 'withdrawal_balance' ? 'withdrawal_balance' : 'charged_balance';
    const numDelta = Number(delta);
    if (!userId || Number.isNaN(numDelta)) {
      return res.status(400).json({ success: false, message: 'Valid userId and delta required' });
    }

    const uRef = db.collection('users').doc(String(userId));
    await db.runTransaction(async (t) => {
      const snap = await t.get(uRef);
      if (!snap.exists) throw new Error('User not found');
      const nextVal = Math.max(0, Number(snap.data()[validField] || 0) + numDelta);
      t.update(uRef, { [validField]: nextVal });
    });

    res.json({ success: true, message: 'User balance updated' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users/set-vip', requireAdmin, async (req, res) => {
  try {
    const { userId, vipLevel } = req.body || {};
    const lvl = Math.max(0, Math.min(8, Number(vipLevel || 0)));
    await db.collection('users').doc(String(userId)).update({ vip_level: lvl });
    res.json({ success: true, message: `User VIP set to ${lvl}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// FAST PRODUCT CREATE
app.post('/api/admin/products/create', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const price = Number(body.price);
    const dailyIncome = Number(body.dailyIncome ?? body.daily_income);
    const durationDays = Number(body.durationDays ?? body.duration_days);
    const cycleUnit = normalizeCycleUnit(body.cycleUnit ?? body.cycle_unit ?? 'day');
    const vipLevel = Number(body.vipLevel ?? body.vip_level ?? 0);
    const cleanImg = String(body.image || body.imageUrl || body.image_url || '').trim();

    if (!name) return res.status(400).json({ success: false, message: 'Plan name required' });
    if (!(price > 0)) return res.status(400).json({ success: false, message: 'Price must be > 0' });
    if (!(dailyIncome > 0)) return res.status(400).json({ success: false, message: 'Cycle income must be > 0' });
    if (!(durationDays > 0)) return res.status(400).json({ success: false, message: 'Duration cycles must be > 0' });
    if (isOversizedImage(cleanImg)) {
      return res.status(400).json({ success: false, message: 'Image size too large (use a shorter URL or smaller image)' });
    }

    const id = 'PLN' + Date.now();
    const docData = {
      id,
      name,
      image: cleanImg,
      imageUrl: cleanImg,
      image_url: cleanImg,
      price,
      daily_income: dailyIncome,
      duration_days: durationDays,
      cycle_unit: cycleUnit,
      vip_level: vipLevel,
      is_limited: false,
      remaining_copies: 9999,
      createdAt: Date.now()
    };

    await db.collection('products').doc(id).set(docData);
    invalidateProductsCache();

    const formatted = formatProduct(docData);
    res.json({ success: true, id, product: formatted, message: 'Product created' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/products/update', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Product id required' });

    const updateObj = {
      name: String(body.name || '').trim(),
      price: Number(body.price || 0),
      daily_income: Number(body.dailyIncome ?? body.daily_income ?? 0),
      duration_days: Number(body.durationDays ?? body.duration_days ?? 1),
      cycle_unit: normalizeCycleUnit(body.cycleUnit ?? body.cycle_unit ?? 'day'),
      vip_level: Number(body.vipLevel ?? body.vip_level ?? 0)
    };

    if (body.image !== undefined || body.imageUrl !== undefined || body.image_url !== undefined) {
      const cleanImg = String(body.image || body.imageUrl || body.image_url || '').trim();
      if (isOversizedImage(cleanImg)) {
        return res.status(400).json({ success: false, message: 'Image size too large' });
      }
      updateObj.image = cleanImg;
      updateObj.imageUrl = cleanImg;
      updateObj.image_url = cleanImg;
    }

    await db.collection('products').doc(id).set(updateObj, { merge: true });
    invalidateProductsCache();
    res.json({ success: true, message: 'Plan updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/products/delete', requireAdmin, async (req, res) => {
  try {
    const { id } = req.body || {};
    await db.collection('products').doc(String(id)).delete();
    invalidateProductsCache();
    res.json({ success: true, message: 'Plan deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/banners', requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('banners').get();
    res.json({ success: true, banners: docsToArray(snap) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/banners/create', requireAdmin, async (req, res) => {
  try {
    const { title = '', subtitle = '', imageUrl = '' } = req.body || {};
    if (isOversizedImage(imageUrl)) return res.status(400).json({ success: false, message: 'Banner image too large' });
    const id = 'BNR' + Date.now();
    await db.collection('banners').doc(id).set({
      id,
      title: String(title).trim(),
      subtitle: String(subtitle).trim(),
      imageUrl: String(imageUrl),
      active: true,
      createdAt: Date.now()
    });
    invalidateConfigCache();
    res.json({ success: true, id, message: 'Banner added' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/banners/toggle', requireAdmin, async (req, res) => {
  try {
    const { id, active } = req.body || {};
    await db.collection('banners').doc(String(id)).update({ active: Boolean(active) });
    invalidateConfigCache();
    res.json({ success: true, message: 'Banner updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/banners/delete', requireAdmin, async (req, res) => {
  try {
    const { id } = req.body || {};
    await db.collection('banners').doc(String(id)).delete();
    invalidateConfigCache();
    res.json({ success: true, message: 'Banner deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/popup-banner/update', requireAdmin, async (req, res) => {
  try {
    const { popupBanner = {} } = req.body || {};
    if (isOversizedImage(popupBanner.imageUrl)) {
      return res.status(400).json({ success: false, message: 'Popup image too large' });
    }
    const ref = db.collection('app_config').doc('1');
    const snap = await ref.get();
    const prev = snap.exists ? (snap.data()?.data || {}) : {};
    await ref.set({
      data: {
        ...prev,
        popupBanner: {
          ...(prev.popupBanner || {}),
          ...popupBanner,
          enabled: Boolean(popupBanner.enabled)
        }
      }
    });
    invalidateConfigCache();
    res.json({ success: true, message: 'Popup banner saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/promos', requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('promo_codes').get();
    res.json({ success: true, promos: docsToArray(snap) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/promos/create', requireAdmin, async (req, res) => {
  try {
    const { code, reward, wallet = 'charged' } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    const amt = Number(reward || 0);
    if (!cleanCode || amt <= 0) return res.status(400).json({ success: false, message: 'Valid code and reward required' });
    await db.collection('promo_codes').doc(cleanCode).set({
      code: cleanCode,
      reward: amt,
      wallet: wallet === 'withdrawal' ? 'withdrawal' : 'charged',
      createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: `Promo ${cleanCode} saved` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/promos/delete', requireAdmin, async (req, res) => {
  try {
    const { code } = req.body || {};
    await db.collection('promo_codes').doc(String(code || '').trim().toUpperCase()).delete();
    res.json({ success: true, message: 'Promo code deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/blog/delete', requireAdmin, async (req, res) => {
  try {
    const { postId } = req.body || {};
    await db.collection('blog_posts').doc(String(postId)).delete();
    res.json({ success: true, message: 'Blog post deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/tickets/reply', requireAdmin, async (req, res) => {
  try {
    const { ticketId, reply } = req.body || {};
    if (!ticketId || !String(reply || '').trim()) {
      return res.status(400).json({ success: false, message: 'ticketId and reply required' });
    }
    await db.collection('support_tickets').doc(String(ticketId)).update({
      admin_reply: String(reply).trim(),
      replied_at: new Date().toISOString()
    });
    res.json({ success: true, message: 'Reply sent to user' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/config/update', requireAdmin, async (req, res) => {
  try {
    const { config = {} } = req.body || {};
    const ref = db.collection('app_config').doc('1');
    const snap = await ref.get();
    const prev = snap.exists ? (snap.data()?.data || {}) : {};
    await ref.set({ data: { ...prev, ...config } });
    invalidateConfigCache();
    res.json({ success: true, message: 'App config updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 10. START SERVER
// ============================================================================
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`GrowthWave API running on port ${PORT}`);
  try {
    await seedDefaultsIfEmpty();
  } catch (e) {
    console.warn('Seed warning:', e.message);
  }
});
