require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY
          ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
          : undefined
      })
    });
  }
}

const db = admin.firestore();

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

const REFERRAL_RATES = {
  level1: 0.60, // 60%
  level2: 0.04, // 4%
  level3: 0.01  // 1%
};

const WHEEL_REWARDS = [
  { id: 'w1', label: '₹10 Bonus', amount: 10, wallet: 'charged', weight: 30 },
  { id: 'w2', label: '₹25 Bonus', amount: 25, wallet: 'charged', weight: 22 },
  { id: 'w3', label: '₹50 Cash', amount: 50, wallet: 'withdrawal', weight: 15 },
  { id: 'w4', label: '₹100 Cash', amount: 100, wallet: 'withdrawal', weight: 8 },
  { id: 'w5', label: '₹5 Try Again Boost', amount: 5, wallet: 'charged', weight: 20 },
  { id: 'w6', label: '₹250 Jackpot', amount: 250, wallet: 'withdrawal', weight: 5 }
];

const MAX_IMAGE_CHARS = 750000; // Keeps Firestore documents safely under 1 MB limit

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifySecret(secret, stored) {
  if (!secret || !stored) return false;
  const plain = String(secret);
  const strStored = String(stored);
  if (!strStored.includes(':')) {
    // Fallback for legacy unhashed records
    return plain === strStored;
  }
  const [salt, keyHex] = strStored.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(plain, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

function calcVip(investment) {
  let lvl = 0;
  for (const t of VIP_TIERS) {
    if (Number(investment) >= t.req) lvl = t.level;
  }
  return lvl;
}

function formatUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    phone: u.phone,
    realName: u.real_name,
    ownInviteCode: u.own_invite_code,
    invitedBy: u.invited_by,
    chargedBalance: Number(u.charged_balance || 0),
    withdrawalBalance: Number(u.withdrawal_balance || 0),
    totalInvestment: Number(u.total_investment || 0),
    totalRecharge: Number(u.total_recharge || 0),
    totalWithdraw: Number(u.total_withdraw || 0),
    vipLevel: Number(u.vip_level || 0),
    createdAt: toIso(u.created_at)
  };
}

// IST (UTC+5:30) date key so daily resets happen at 12:00 AM IST
function getTodayKey() {
  const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return istDate.toISOString().slice(0, 10);
}

function pickWeightedReward(pool) {
  const totalWeight = pool.reduce((sum, item) => sum + Number(item.weight || 1), 0);
  let roll = Math.random() * totalWeight;
  for (const item of pool) {
    roll -= Number(item.weight || 1);
    if (roll <= 0) return item;
  }
  return pool[0];
}

function toIso(val) {
  if (!val) return new Date().toISOString();
  if (typeof val === 'string') return val;
  if (val.toDate) return val.toDate().toISOString();
  return new Date(val).toISOString();
}

function docToObj(doc) {
  if (!doc || !doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

function docsToArray(snap) {
  if (!snap || snap.empty) return [];
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function isOversizedImage(val) {
  return typeof val === 'string' && val.length > MAX_IMAGE_CHARS;
}

app.get('/', (req, res) => {
  res.json({ success: true, service: 'GrowthWave Capital API', status: 'running', database: 'firebase' });
});

app.get('/api/config', async (req, res) => {
  try {
    const doc = await db.collection('app_config').doc('1').get();
    res.json({ success: true, config: doc.exists ? (doc.data()?.data || {}) : {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const snap = await db.collection('products').orderBy('price', 'asc').get();
    const mapped = docsToArray(snap).map((p) => ({
      id: p.id,
      name: p.name,
      image: p.image,
      vipLevel: p.vip_level,
      price: Number(p.price),
      dailyIncome: Number(p.daily_income),
      durationDays: Number(p.duration_days),
      isLimited: Boolean(p.is_limited),
      totalCopies: Number(p.total_copies || 0),
      remainingCopies: Number(p.remaining_copies || 0),
      soldOut: Boolean(p.sold_out),
      soldOutMessage: p.sold_out_message
    }));
    res.json({ success: true, products: mapped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, withdrawPassword, inviteCode, realName } = req.body || {};
    if (!phone || !password || !withdrawPassword) {
      return res.status(400).json({ success: false, message: 'Phone, password and withdrawal password required' });
    }

    const cleanPhone = String(phone).trim();
    const existingSnap = await db.collection('users').where('phone', '==', cleanPhone).limit(1).get();
    if (!existingSnap.empty) {
      return res.status(400).json({ success: false, message: 'Phone number already registered' });
    }

    const uid = 'U' + Date.now().toString().slice(-7) + Math.floor(10 + Math.random() * 89);
    const ownCode = 'GW' + Math.floor(100000 + Math.random() * 900000);
    const nowIso = new Date().toISOString();

    const userRecord = {
      id: uid,
      phone: cleanPhone,
      password: hashSecret(password),
      withdraw_password: hashSecret(withdrawPassword),
      real_name: String(realName || '').trim(),
      own_invite_code: ownCode,
      invited_by: String(inviteCode || 'NONE').trim() || 'NONE',
      charged_balance: 0,
      withdrawal_balance: 0,
      total_investment: 0,
      total_recharge: 0,
      total_withdraw: 0,
      vip_level: 0,
      created_at: nowIso
    };

    await db.collection('users').doc(uid).set(userRecord);
    res.json({ success: true, userId: uid, user: formatUser(userRecord) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password required' });
    }

    const cleanPhone = String(phone).trim();
    const snap = await db.collection('users').where('phone', '==', cleanPhone).limit(1).get();
    const user = snap.empty ? null : docToObj(snap.docs[0]);

    if (!user || !verifySecret(password, user.password)) {
      return res.status(401).json({ success: false, message: 'Invalid phone or password' });
    }

    res.json({ success: true, userId: user.id, user: formatUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/live-sync/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const userDoc = await db.collection('users').doc(uid).get();
    const user = docToObj(userDoc);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const [prodSnap, ordSnap, tktSnap, cfgDoc] = await Promise.all([
      db.collection('products').orderBy('price', 'asc').get(),
      db.collection('orders').where('user_id', '==', uid).get(),
      db.collection('tickets').where('user_id', '==', uid).get(),
      db.collection('app_config').doc('1').get()
    ]);

    const orders = docsToArray(ordSnap).sort((a, b) => toIso(b.created_at).localeCompare(toIso(a.created_at)));
    const tickets = docsToArray(tktSnap).sort((a, b) => toIso(a.created_at).localeCompare(toIso(b.created_at)));

    res.json({
      success: true,
      user: formatUser(user),
      products: docsToArray(prodSnap).map((p) => ({
        id: p.id,
        name: p.name,
        image: p.image,
        vipLevel: p.vip_level,
        price: Number(p.price),
        dailyIncome: Number(p.daily_income),
        durationDays: Number(p.duration_days),
        isLimited: Boolean(p.is_limited),
        totalCopies: Number(p.total_copies || 0),
        remainingCopies: Number(p.remaining_copies || 0),
        soldOut: Boolean(p.sold_out),
        soldOutMessage: p.sold_out_message
      })),
      myProducts: orders.map((o) => ({
        id: o.id,
        productId: o.product_id,
        productName: o.product_name,
        copies: Number(o.copies),
        totalAmount: Number(o.total_amount),
        dailyIncome: Number(o.daily_income),
        durationDays: Number(o.duration_days),
        status: o.status,
        createdAt: toIso(o.created_at)
      })),
      tickets: tickets.map((t) => ({
        id: t.id,
        message: t.message,
        imageData: t.image_data,
        adminReply: t.admin_reply,
        createdAt: toIso(t.created_at)
      })),
      config: cfgDoc.exists ? (cfgDoc.data()?.data || {}) : {}
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/products/buy', async (req, res) => {
  try {
    const { userId, productId, copies = 1 } = req.body || {};
    const qty = Math.max(1, Math.floor(Number(copies || 1)));
    if (!userId || !productId) {
      return res.status(400).json({ success: false, message: 'userId and productId are required' });
    }

    const userRef = db.collection('users').doc(String(userId));
    const prodRef = db.collection('products').doc(String(productId));

    const result = await db.runTransaction(async (tx) => {
      const [userDoc, prodDoc] = await Promise.all([tx.get(userRef), tx.get(prodRef)]);
      const user = docToObj(userDoc);
      const prod = docToObj(prodDoc);

      if (!user || !prod) {
        return { errorStatus: 404, message: 'User or product not found' };
      }
      if (prod.sold_out || (prod.is_limited && Number(prod.remaining_copies) < qty)) {
        return { errorStatus: 400, message: prod.sold_out_message || 'Product sold out' };
      }

      const totalCost = Number(prod.price) * qty;
      const currentCharged = Number(user.charged_balance || 0);
      if (currentCharged < totalCost) {
        return { errorStatus: 400, message: 'Insufficient charged balance. Please recharge first.' };
      }

      const newCharged = currentCharged - totalCost;
      const newInvest = Number(user.total_investment || 0) + totalCost;
      const newVip = calcVip(newInvest);
      const nowIso = new Date().toISOString();

      tx.update(userRef, {
        charged_balance: newCharged,
        total_investment: newInvest,
        vip_level: newVip
      });

      if (prod.is_limited) {
        const rem = Math.max(0, Number(prod.remaining_copies) - qty);
        tx.update(prodRef, {
          remaining_copies: rem,
          sold_out: rem <= 0
        });
      }

      const orderId = 'ORD' + Date.now() + Math.floor(10 + Math.random() * 89);
      tx.set(db.collection('orders').doc(orderId), {
        id: orderId,
        user_id: user.id,
        product_id: prod.id,
        product_name: prod.name,
        copies: qty,
        total_amount: totalCost,
        daily_income: Number(prod.daily_income) * qty,
        duration_days: Number(prod.duration_days),
        status: 'Active',
        created_at: nowIso
      });

      const txId = 'TX' + Date.now() + Math.floor(10 + Math.random() * 89);
      tx.set(db.collection('transactions').doc(txId), {
        id: txId,
        user_id: user.id,
        type: 'Investment',
        amount_label: `-₹${totalCost.toFixed(2)}`,
        raw_amount: totalCost,
        status: 'Completed',
        tx_ref: orderId,
        created_at: nowIso
      });

      return {
        errorStatus: null,
        orderId,
        message: `${prod.name} purchased successfully!`
      };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({ success: true, message: result.message, orderId: result.orderId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/recharge/create', async (req, res) => {
  try {
    const { userId, amount, channel } = req.body || {};
    const amt = Number(amount);
    if (!userId || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid recharge details' });
    }

    const orderId = 'RCH' + Date.now();
    await db.collection('transactions').doc(orderId).set({
      id: orderId,
      user_id: String(userId),
      type: 'Recharge',
      amount_label: `+₹${amt.toFixed(2)}`,
      raw_amount: amt,
      status: 'Pending',
      meta: { channel: channel || 'UPI' },
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
    const amt = Number(amount || 0);
    if (!userId || !utr) {
      return res.status(400).json({ success: false, message: 'UTR is required' });
    }

    const cleanUtr = String(utr).trim();

    if (razorpay_order_id) {
      const txDoc = await db.collection('transactions').doc(String(razorpay_order_id)).get();
      if (!txDoc.exists || txDoc.data()?.user_id !== String(userId)) {
        return res.status(404).json({ success: false, message: 'Recharge order not found' });
      }
      await txDoc.ref.update({
        tx_ref: cleanUtr,
        status: 'Pending'
      });
      return res.json({
        success: true,
        status: 'Pending',
        orderId: txDoc.id,
        message: 'Payment submitted for verification'
      });
    }

    const rchId = 'RCH' + Date.now();
    await db.collection('transactions').doc(rchId).set({
      id: rchId,
      user_id: String(userId),
      type: 'Recharge',
      amount_label: `+₹${amt.toFixed(2)}`,
      raw_amount: amt,
      status: 'Pending',
      tx_ref: cleanUtr,
      created_at: new Date().toISOString()
    });

    res.json({
      success: true,
      status: 'Pending',
      orderId: rchId,
      message: 'Payment submitted for verification'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/withdraw/auto-upi', async (req, res) => {
  try {
    const { userId, amount, withdrawPassword, bankName, realName, bankAccount, upiId, ifsc } = req.body || {};
    const amt = Number(amount);
    if (!userId || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal amount' });
    }

    const userRef = db.collection('users').doc(String(userId));

    const result = await db.runTransaction(async (tx) => {
      const userDoc = await tx.get(userRef);
      const user = docToObj(userDoc);
      if (!user) return { errorStatus: 404, message: 'User not found' };
      if (!verifySecret(withdrawPassword, user.withdraw_password)) {
        return { errorStatus: 401, message: 'Incorrect withdrawal password' };
      }
      const currentBal = Number(user.withdrawal_balance || 0);
      if (currentBal < amt) {
        return { errorStatus: 400, message: 'Insufficient withdrawal balance' };
      }

      const newBal = currentBal - amt;
      const newTotalWithdraw = Number(user.total_withdraw || 0) + amt;
      const nowIso = new Date().toISOString();

      tx.update(userRef, {
        withdrawal_balance: newBal,
        total_withdraw: newTotalWithdraw
      });

      const txId = 'WDR' + Date.now() + Math.floor(10 + Math.random() * 89);
      tx.set(db.collection('transactions').doc(txId), {
        id: txId,
        user_id: user.id,
        type: 'Withdrawal',
        amount_label: `-₹${amt.toFixed(2)}`,
        raw_amount: amt,
        status: 'Pending',
        meta: { bankName, realName, bankAccount, upiId, ...(ifsc ? { ifsc } : {}) },
        created_at: nowIso
      });

      return { errorStatus: null, txId };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: 'Withdrawal request submitted and is under review.',
      txId: result.txId
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/bills/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await db.collection('transactions').where('user_id', '==', uid).get();
    const rows = docsToArray(snap).sort((a, b) => toIso(b.created_at).localeCompare(toIso(a.created_at)));

    res.json({
      success: true,
      bills: rows.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount_label,
        status: t.status,
        txId: t.tx_ref,
        createdAt: toIso(t.created_at)
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/promo/claim', async (req, res) => {
  try {
    const { userId, code } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!userId || !cleanCode) {
      return res.status(400).json({ success: false, message: 'userId and code are required' });
    }

    const promoSnap = await db
      .collection('promo_codes')
      .where('code', '==', cleanCode)
      .where('active', '==', true)
      .limit(1)
      .get();

    const promo = promoSnap.empty ? null : docToObj(promoSnap.docs[0]);
    if (!promo) {
      return res.status(400).json({ success: false, message: 'Invalid or expired promo code' });
    }

    const alreadyClaimedSnap = await db
      .collection('transactions')
      .where('user_id', '==', String(userId))
      .where('type', '==', 'Promo Bonus')
      .where('tx_ref', '==', cleanCode)
      .limit(1)
      .get();

    if (!alreadyClaimedSnap.empty) {
      return res.status(400).json({ success: false, message: 'You have already claimed this promo code' });
    }

    const userRef = db.collection('users').doc(String(userId));
    const result = await db.runTransaction(async (tx) => {
      const userDoc = await tx.get(userRef);
      const user = docToObj(userDoc);
      if (!user) return { errorStatus: 404, message: 'User not found' };

      const reward = Number(promo.reward || 0);
      const field = promo.wallet === 'withdrawal' ? 'withdrawal_balance' : 'charged_balance';
      const updatedVal = Number(user[field] || 0) + reward;
      const nowIso = new Date().toISOString();

      tx.update(userRef, { [field]: updatedVal });

      const txId = 'PRM' + Date.now();
      tx.set(db.collection('transactions').doc(txId), {
        id: txId,
        user_id: user.id,
        type: 'Promo Bonus',
        amount_label: `+₹${reward.toFixed(2)}`,
        raw_amount: reward,
        status: 'Completed',
        tx_ref: cleanCode,
        created_at: nowIso
      });

      return { errorStatus: null, reward };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({ success: true, message: `₹${result.reward} bonus credited!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// DAILY CHECK-IN, TASKS, LUCKY WHEEL, TEAM, ORDERS & ENGAGEMENT
// ============================================================================

app.get('/api/checkin/status/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const today = getTodayKey();
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const snap = await db
      .collection('transactions')
      .where('user_id', '==', uid)
      .where('type', '==', 'Check-In')
      .get();

    const logs = docsToArray(snap);
    const claimedToday = logs.some((item) => item.tx_ref === `CHK-${today}`);
    const streak = Math.min(30, logs.length);
    const nextReward = Math.min(100, 10 + streak * 5);

    res.json({
      success: true,
      claimedToday,
      streak,
      nextReward,
      totalCheckIns: logs.length
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/checkin/claim', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });

    const today = getTodayKey();
    const refCode = `CHK-${today}`;
    const userRef = db.collection('users').doc(String(userId));
    const claimMarkerRef = db.collection('transactions').doc(`CLAIM_CHK_${userId}_${today}`);

    const result = await db.runTransaction(async (tx) => {
      const [userDoc, markerDoc, snap] = await Promise.all([
        tx.get(userRef),
        tx.get(claimMarkerRef),
        tx.get(
          db.collection('transactions')
            .where('user_id', '==', String(userId))
            .where('type', '==', 'Check-In')
        )
      ]);

      const user = docToObj(userDoc);
      if (!user) return { errorStatus: 404, message: 'User not found' };
      if (markerDoc.exists) {
        return { errorStatus: 400, message: 'Daily check-in already claimed today' };
      }

      const pastLogs = docsToArray(snap);
      const streak = Math.min(30, pastLogs.length);
      const reward = Math.min(100, 10 + streak * 5);
      const newCharged = Number(user.charged_balance || 0) + reward;
      const nowIso = new Date().toISOString();

      tx.update(userRef, { charged_balance: newCharged });
      tx.set(claimMarkerRef, {
        id: claimMarkerRef.id,
        user_id: user.id,
        type: 'Check-In',
        amount_label: `+₹${reward.toFixed(2)}`,
        raw_amount: reward,
        status: 'Completed',
        tx_ref: refCode,
        created_at: nowIso
      });

      return {
        errorStatus: null,
        reward,
        streak: streak + 1,
        chargedBalance: newCharged
      };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: `Daily check-in complete! ₹${result.reward} added to charged balance.`,
      reward: result.reward,
      streak: result.streak,
      chargedBalance: result.chargedBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/tasks/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const userDoc = await db.collection('users').doc(uid).get();
    const user = docToObj(userDoc);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const [refSnap, txSnap] = await Promise.all([
      db.collection('users').where('invited_by', '==', user.own_invite_code).get(),
      db.collection('transactions').where('user_id', '==', uid).where('type', '==', 'Task Reward').get()
    ]);

    const claimedSet = new Set(docsToArray(txSnap).map((t) => t.tx_ref));
    const inviteCount = refSnap.size;
    const investAmt = Number(user.total_investment || 0);

    const tasks = [
      {
        id: 'task_invite_1',
        title: 'Invite 1 Active Member',
        description: 'Share your referral code and bring 1 registered friend.',
        reward: 30,
        wallet: 'withdrawal',
        progress: Math.min(1, inviteCount),
        target: 1,
        eligible: inviteCount >= 1,
        claimed: claimedSet.has('TASK_task_invite_1')
      },
      {
        id: 'task_invite_5',
        title: 'Team Builder (5 Invites)',
        description: 'Grow your direct referral circle to 5 members.',
        reward: 150,
        wallet: 'withdrawal',
        progress: Math.min(5, inviteCount),
        target: 5,
        eligible: inviteCount >= 5,
        claimed: claimedSet.has('TASK_task_invite_5')
      },
      {
        id: 'task_invest_1000',
        title: 'First ₹1,000 Investment Milestone',
        description: 'Reach ₹1,000 cumulative active plan investment.',
        reward: 60,
        wallet: 'charged',
        progress: Math.min(1000, investAmt),
        target: 1000,
        eligible: investAmt >= 1000,
        claimed: claimedSet.has('TASK_task_invest_1000')
      }
    ];

    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/tasks/claim', async (req, res) => {
  try {
    const { userId, taskId } = req.body || {};
    if (!userId || !taskId) {
      return res.status(400).json({ success: false, message: 'userId and taskId are required' });
    }

    const userRef = db.collection('users').doc(String(userId));
    const refKey = `TASK_${taskId}`;
    const claimMarkerRef = db.collection('transactions').doc(`CLAIM_${refKey}_${userId}`);

    const result = await db.runTransaction(async (tx) => {
      const [userDoc, markerDoc] = await Promise.all([tx.get(userRef), tx.get(claimMarkerRef)]);
      const user = docToObj(userDoc);
      if (!user) return { errorStatus: 404, message: 'User not found' };
      if (markerDoc.exists) {
        return { errorStatus: 400, message: 'Task reward already claimed' };
      }

      const refSnap = await tx.get(
        db.collection('users').where('invited_by', '==', user.own_invite_code)
      );
      const inviteCount = refSnap.size;
      const investAmt = Number(user.total_investment || 0);

      const catalog = {
        task_invite_1: { reward: 30, wallet: 'withdrawal', ok: inviteCount >= 1 },
        task_invite_5: { reward: 150, wallet: 'withdrawal', ok: inviteCount >= 5 },
        task_invest_1000: { reward: 60, wallet: 'charged', ok: investAmt >= 1000 }
      };

      const taskSpec = catalog[taskId];
      if (!taskSpec) return { errorStatus: 404, message: 'Task not found' };
      if (!taskSpec.ok) return { errorStatus: 400, message: 'Task requirements not met yet' };

      const col = taskSpec.wallet === 'withdrawal' ? 'withdrawal_balance' : 'charged_balance';
      const nextBal = Number(user[col] || 0) + taskSpec.reward;

      tx.update(userRef, { [col]: nextBal });
      tx.set(claimMarkerRef, {
        id: claimMarkerRef.id,
        user_id: user.id,
        type: 'Task Reward',
        amount_label: `+₹${taskSpec.reward.toFixed(2)}`,
        raw_amount: taskSpec.reward,
        status: 'Completed',
        tx_ref: refKey,
        created_at: new Date().toISOString()
      });

      return { errorStatus: null, reward: taskSpec.reward, wallet: taskSpec.wallet };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: `Claimed ₹${result.reward} task reward!`,
      reward: result.reward,
      wallet: result.wallet
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/wheel/spin', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });

    const today = getTodayKey();
    const refCode = `WHL-${today}`;
    const userRef = db.collection('users').doc(String(userId));
    const claimMarkerRef = db.collection('transactions').doc(`CLAIM_WHL_${userId}_${today}`);

    const result = await db.runTransaction(async (tx) => {
      const [userDoc, markerDoc] = await Promise.all([tx.get(userRef), tx.get(claimMarkerRef)]);
      const user = docToObj(userDoc);
      if (!user) return { errorStatus: 404, message: 'User not found' };
      if (markerDoc.exists) {
        return { errorStatus: 400, message: 'Daily free Lucky Wheel spin already used today' };
      }

      const prize = pickWeightedReward(WHEEL_REWARDS);
      const col = prize.wallet === 'withdrawal' ? 'withdrawal_balance' : 'charged_balance';
      const nextBal = Number(user[col] || 0) + prize.amount;

      tx.update(userRef, { [col]: nextBal });
      tx.set(claimMarkerRef, {
        id: claimMarkerRef.id,
        user_id: user.id,
        type: 'Lucky Wheel',
        amount_label: `+₹${prize.amount.toFixed(2)}`,
        raw_amount: prize.amount,
        status: 'Completed',
        tx_ref: refCode,
        created_at: new Date().toISOString()
      });

      return { errorStatus: null, prize };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      prize: result.prize,
      message: `You won ${result.prize.label}!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/team/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const userDoc = await db.collection('users').doc(uid).get();
    const user = docToObj(userDoc);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const l1Snap = await db.collection('users').where('invited_by', '==', user.own_invite_code).get();
    const level1 = docsToArray(l1Snap);
    const l1Codes = level1.map((u) => u.own_invite_code).filter(Boolean);

    let level2 = [];
    if (l1Codes.length > 0) {
      const l2Chunks = [];
      for (let i = 0; i < l1Codes.length; i += 30) {
        const batch = l1Codes.slice(i, i + 30);
        const snap = await db.collection('users').where('invited_by', 'in', batch).get();
        l2Chunks.push(...docsToArray(snap));
      }
      level2 = l2Chunks;
    }

    const l2Codes = level2.map((u) => u.own_invite_code).filter(Boolean);
    let level3 = [];
    if (l2Codes.length > 0) {
      const l3Chunks = [];
      for (let i = 0; i < l2Codes.length; i += 30) {
        const batch = l2Codes.slice(i, i + 30);
        const snap = await db.collection('users').where('invited_by', 'in', batch).get();
        l3Chunks.push(...docsToArray(snap));
      }
      level3 = l3Chunks;
    }

    const sumInvest = (arr) => arr.reduce((acc, item) => acc + Number(item.total_investment || 0), 0);
    const l1Invest = sumInvest(level1);
    const l2Invest = sumInvest(level2);
    const l3Invest = sumInvest(level3);

    const estimatedCommission =
      l1Invest * REFERRAL_RATES.level1 +
      l2Invest * REFERRAL_RATES.level2 +
      l3Invest * REFERRAL_RATES.level3;

    const mapMember = (m, tier) => ({
      id: m.id,
      phoneMasked: m.phone ? String(m.phone).replace(/(\d{2})\d+(\d{2})/, '$1******$2') : '',
      realName: m.real_name || 'Member',
      tier,
      totalInvestment: Number(m.total_investment || 0),
      joinedAt: toIso(m.created_at)
    });

    res.json({
      success: true,
      inviteCode: user.own_invite_code,
      rates: { level1: '60%', level2: '4%', level3: '1%' },
      summary: {
        totalMembers: level1.length + level2.length + level3.length,
        level1Count: level1.length,
        level2Count: level2.length,
        level3Count: level3.length,
        totalTeamInvestment: l1Invest + l2Invest + l3Invest,
        estimatedCommission: Number(estimatedCommission.toFixed(2))
      },
      members: {
        level1: level1.map((m) => mapMember(m, 1)),
        level2: level2.map((m) => mapMember(m, 2)),
        level3: level3.map((m) => mapMember(m, 3))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/orders/claim-income', async (req, res) => {
  try {
    const { userId, orderId } = req.body || {};
    if (!userId || !orderId) {
      return res.status(400).json({ success: false, message: 'userId and orderId are required' });
    }

    const today = getTodayKey();
    const payoutRef = `INC-${orderId}-${today}`;
    const userRef = db.collection('users').doc(String(userId));
    const orderRef = db.collection('orders').doc(String(orderId));
    const claimMarkerRef = db.collection('transactions').doc(`CLAIM_INC_${orderId}_${today}`);

    const result = await db.runTransaction(async (tx) => {
      const [userDoc, orderDoc, markerDoc] = await Promise.all([
        tx.get(userRef),
        tx.get(orderRef),
        tx.get(claimMarkerRef)
      ]);

      const user = docToObj(userDoc);
      const order = docToObj(orderDoc);

      if (!user || !order || order.user_id !== user.id) {
        return { errorStatus: 404, message: 'Order or user not found' };
      }
      if (order.status !== 'Active') {
        return { errorStatus: 400, message: 'Order is not active' };
      }
      if (markerDoc.exists) {
        return { errorStatus: 400, message: 'Today’s income for this order is already claimed' };
      }

      const incomeAmt = Number(order.daily_income || 0);
      const nextWithdrawBal = Number(user.withdrawal_balance || 0) + incomeAmt;

      tx.update(userRef, { withdrawal_balance: nextWithdrawBal });
      tx.set(claimMarkerRef, {
        id: claimMarkerRef.id,
        user_id: user.id,
        type: 'Daily Income',
        amount_label: `+₹${incomeAmt.toFixed(2)}`,
        raw_amount: incomeAmt,
        status: 'Completed',
        tx_ref: payoutRef,
        created_at: new Date().toISOString()
      });

      return { errorStatus: null, amount: incomeAmt, withdrawalBalance: nextWithdrawBal };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: `₹${result.amount.toFixed(2)} daily income credited to withdrawal balance!`,
      amount: result.amount,
      withdrawalBalance: result.withdrawalBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/blog/list', async (req, res) => {
  try {
    const snap = await db.collection('blog_posts').get();
    const rows = docsToArray(snap).sort((a, b) => toIso(b.created_at).localeCompare(toIso(a.created_at)));

    res.json({
      success: true,
      posts: rows.map((p) => ({
        id: p.id,
        userId: p.user_id,
        text: p.text,
        images: p.images || [],
        likes: Number(p.likes || 0),
        comments: Array.isArray(p.comments) ? p.comments : [],
        createdAt: toIso(p.created_at)
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/blog/submit', async (req, res) => {
  try {
    const { userId, text, images } = req.body || {};
    const safeImages = Array.isArray(images) ? images.slice(0, 2) : [];
    if (safeImages.some(isOversizedImage)) {
      return res.status(400).json({ success: false, message: 'Image size too large. Please compress image before uploading.' });
    }

    const postId = 'BLOG' + Date.now();
    const record = {
      id: postId,
      user_id: String(userId || ''),
      text: String(text || '').trim(),
      images: safeImages,
      likes: 0,
      comments: [],
      created_at: new Date().toISOString()
    };

    await db.collection('blog_posts').doc(postId).set(record);
    res.json({ success: true, post: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/blog/:postId/like', async (req, res) => {
  try {
    const { postId } = req.params;
    const docRef = db.collection('blog_posts').doc(postId);

    const result = await db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      const post = docToObj(doc);
      if (!post) return { errorStatus: 404, message: 'Blog post not found' };

      const nextLikes = Number(post.likes || 0) + 1;
      tx.update(docRef, { likes: nextLikes });
      return { errorStatus: null, likes: nextLikes };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({ success: true, postId, likes: result.likes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/blog/:postId/comment', async (req, res) => {
  try {
    const { postId } = req.params;
    const { userId, comment } = req.body || {};
    if (!userId || !String(comment || '').trim()) {
      return res.status(400).json({ success: false, message: 'userId and comment are required' });
    }

    const docRef = db.collection('blog_posts').doc(postId);
    const result = await db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      const post = docToObj(doc);
      if (!post) return { errorStatus: 404, message: 'Blog post not found' };

      const existingComments = Array.isArray(post.comments) ? post.comments : [];
      const newComment = {
        id: 'CMT' + Date.now(),
        userId: String(userId),
        text: String(comment).trim(),
        createdAt: new Date().toISOString()
      };
      const updatedComments = [...existingComments, newComment];

      tx.update(docRef, { comments: updatedComments });
      return { errorStatus: null, comment: newComment, comments: updatedComments };
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ success: false, message: result.message });
    }

    res.json({ success: true, comment: result.comment, comments: result.comments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/service/support-info', async (req, res) => {
  try {
    const cfgDoc = await db.collection('app_config').doc('1').get();
    const cfg = cfgDoc.exists ? (cfgDoc.data()?.data || {}) : {};
    const whatsappNumber = String(cfg.whatsappNumber || process.env.SUPPORT_WHATSAPP_NUMBER || '').replace(/\D/g, '');
    const defaultMsg = encodeURIComponent(
      cfg.whatsappDefaultMessage || 'Hello GrowthWave Capital Support, I need assistance with my account.'
    );

    res.json({
      success: true,
      whatsappEnabled: Boolean(whatsappNumber),
      whatsappNumber: whatsappNumber || null,
      whatsappUrl: whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${defaultMsg}` : null,
      supportHours: cfg.supportHours || '24/7 Live Assistance',
      quickReplies: [
        'How do I verify my recharge UTR?',
        'When will my withdrawal be processed?',
        'How do 3-tier referral commissions work?',
        'How do I claim daily check-in & Lucky Wheel?'
      ]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/service/ticket', async (req, res) => {
  try {
    const { userId, message, imageData } = req.body || {};
    if (!userId || (!message && !imageData)) {
      return res.status(400).json({ success: false, message: 'Message or image required' });
    }
    if (isOversizedImage(imageData)) {
      return res.status(400).json({ success: false, message: 'Image size too large. Please compress image before sending.' });
    }

    const ticketId = 'TKT' + Date.now();
    const record = {
      id: ticketId,
      user_id: String(userId),
      message: String(message || '').trim(),
      image_data: String(imageData || ''),
      admin_reply: '',
      created_at: new Date().toISOString()
    };

    await db.collection('tickets').doc(ticketId).set(record);
    res.json({ success: true, ticket: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/service/ticket/:ticketId/reply', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { userId, message, imageData } = req.body || {};
    if (!userId || (!message && !imageData)) {
      return res.status(400).json({ success: false, message: 'userId and message or image required' });
    }
    if (isOversizedImage(imageData)) {
      return res.status(400).json({ success: false, message: 'Image size too large. Please compress image before sending.' });
    }

    const docRef = db.collection('tickets').doc(ticketId);
    const doc = await docRef.get();
    const existing = docToObj(doc);
    if (!existing) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (existing.user_id !== String(userId)) {
      return res.status(403).json({ success: false, message: 'You are not authorized to reply to this ticket' });
    }

    const appendedMessage = [existing.message, `[Follow-up]: ${String(message || '').trim()}`]
      .filter(Boolean)
      .join('\n');

    const updatedFields = {
      message: appendedMessage,
      image_data: imageData ? String(imageData) : (existing.image_data || '')
    };

    await docRef.update(updatedFields);
    res.json({ success: true, ticket: { ...existing, ...updatedFields } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
