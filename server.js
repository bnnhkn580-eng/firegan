const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'GW_ADMIN_2026';

// Supabase persistent storage configuration
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY ||
  '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Local disk fallback
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

app.use(
  cors({
    origin: '*',
    allowedHeaders: [
      'Content-Type',
      'x-admin-secret',
      'x-admin-key',
      'x-user-id',
      'Authorization'
    ]
  })
);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = 'ID') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(v) {
  return Math.round((toNum(v, 0) + Number.EPSILON) * 100) / 100;
}

function defaultState() {
  return {
    users: [],
    recharges: [],
    withdrawals: [],
    products: [],
    investments: [],
    promos: [],
    promoRedemptions: [],
    transactions: [],
    auditLogs: [],
    chats: {},
    config: {
      brandName: 'Admin Panel',
      inviteBonus: 0,
      inviteBonusAmount: 0,
      minWithdraw: 100,
      withdrawFeePercent: 0,
      upiId: '',
      qrCodeImage: '',
      customServiceLink: '',
      popupBanner: '',
      homeBanner: '',
      maintenanceMode: false,
      connectedSite: null,
      liveCode: null
    }
  };
}

function ensureLocalDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultState(), null, 2), 'utf8');
  }
}

function readLocalDb() {
  ensureLocalDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      recharges: Array.isArray(parsed.recharges) ? parsed.recharges : [],
      withdrawals: Array.isArray(parsed.withdrawals) ? parsed.withdrawals : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
      investments: Array.isArray(parsed.investments) ? parsed.investments : [],
      promos: Array.isArray(parsed.promos) ? parsed.promos : [],
      promoRedemptions: Array.isArray(parsed.promoRedemptions) ? parsed.promoRedemptions : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
      chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      config: { ...base.config, ...(parsed.config || {}) }
    };
  } catch {
    const fresh = defaultState();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
}

function writeLocalDb(data) {
  ensureLocalDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function sbGetState(key) {
  const url = `${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) {
    throw new Error(`Supabase GET error (${res.status})`);
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0].value : null;
}

async function sbSetState(key, value) {
  const url = `${SUPABASE_URL}/rest/v1/app_state?on_conflict=key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify([{ key, value, updated_at: nowIso() }])
  });
  if (!res.ok) {
    throw new Error(`Supabase UPSERT error (${res.status})`);
  }
}

async function loadDb() {
  const local = readLocalDb();
  if (!USE_SUPABASE) return local;
  try {
    const remote = await sbGetState('admin_suite_full_db');
    if (remote && typeof remote === 'object') {
      const base = defaultState();
      const merged = {
        ...base,
        ...remote,
        users: Array.isArray(remote.users) ? remote.users : [],
        recharges: Array.isArray(remote.recharges) ? remote.recharges : [],
        withdrawals: Array.isArray(remote.withdrawals) ? remote.withdrawals : [],
        products: Array.isArray(remote.products) ? remote.products : [],
        investments: Array.isArray(remote.investments) ? remote.investments : [],
        promos: Array.isArray(remote.promos) ? remote.promos : [],
        promoRedemptions: Array.isArray(remote.promoRedemptions) ? remote.promoRedemptions : [],
        transactions: Array.isArray(remote.transactions) ? remote.transactions : [],
        auditLogs: Array.isArray(remote.auditLogs) ? remote.auditLogs : [],
        chats: remote.chats && typeof remote.chats === 'object' ? remote.chats : {},
        config: { ...base.config, ...(remote.config || {}) }
      };
      writeLocalDb(merged);
      return merged;
    }
    await sbSetState('admin_suite_full_db', local);
    return local;
  } catch (err) {
    console.warn('[DB] Supabase read fallback to local:', err.message);
    return local;
  }
}

async function saveDb(db) {
  writeLocalDb(db);
  if (USE_SUPABASE) {
    try {
      await sbSetState('admin_suite_full_db', db);
    } catch (err) {
      console.warn('[DB] Supabase write warning:', err.message);
    }
  }
}

function addAudit(db, actor, action, details = {}) {
  db.auditLogs.unshift({
    id: makeId('AUD'),
    actor,
    action,
    details,
    createdAt: nowIso()
  });
  if (db.auditLogs.length > 500) {
    db.auditLogs.length = 500;
  }
}

function addTransaction(db, { uid, type, wallet = 'charged', amount, status = 'completed', note = '', meta = {} }) {
  const tx = {
    txId: makeId('TX'),
    uid: String(uid),
    type,
    wallet,
    amount: roundMoney(amount),
    status,
    note,
    meta,
    createdAt: nowIso()
  };
  db.transactions.unshift(tx);
  if (db.transactions.length > 1000) {
    db.transactions.length = 1000;
  }
  return tx;
}

function findOrCreateUser(db, uid, phone = '', invitedBy = '') {
  const cleanUid = String(uid || '').trim();
  let user = db.users.find(u => String(u.uid || u.userId || u.id) === cleanUid);
  if (!user) {
    user = {
      uid: cleanUid,
      phone: String(phone || '').trim(),
      invitedBy: String(invitedBy || '').trim(),
      inviteCount: 0,
      inviteBonus: 0,
      chargedBalance: 0,
      withdrawBalance: 0,
      vipLevel: 0,
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    db.users.push(user);

    if (user.invitedBy) {
      const inviter = db.users.find(u => String(u.uid) === user.invitedBy);
      if (inviter) {
        inviter.inviteCount = toNum(inviter.inviteCount, 0) + 1;
        const bonus = roundMoney(db.config.inviteBonusAmount ?? db.config.inviteBonus ?? 0);
        if (bonus > 0) {
          inviter.inviteBonus = roundMoney(toNum(inviter.inviteBonus, 0) + bonus);
          inviter.withdrawBalance = roundMoney(toNum(inviter.withdrawBalance, 0) + bonus);
          addTransaction(db, {
            uid: inviter.uid,
            type: 'invite_bonus',
            wallet: 'withdraw',
            amount: bonus,
            note: `Referral bonus for inviting UID ${cleanUid}`
          });
        }
      }
    }
  } else {
    if (phone && !user.phone) user.phone = String(phone).trim();
    if (invitedBy && !user.invitedBy) user.invitedBy = String(invitedBy).trim();
    user.updatedAt = nowIso();
  }
  return user;
}

function requireAdmin(req, res, next) {
  const provided =
    req.headers['x-admin-secret'] ||
    req.headers['x-admin-key'] ||
    (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, ''));

  if (!provided || String(provided).trim() !== ADMIN_SECRET) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: invalid admin secret key'
    });
  }
  next();
}

function computeStats(db) {
  const sumKeys = (list, keys) =>
    list.reduce((sum, row) => {
      for (const k of keys) {
        if (row && row[k] !== undefined && row[k] !== null && Number.isFinite(Number(row[k]))) {
          return roundMoney(sum + Number(row[k]));
        }
      }
      return sum;
    }, 0);

  const isApproved = o =>
    ['approved', 'approve', 'success', 'successful', 'completed', 'done', 'paid'].includes(
      String((o && (o.status || o.state)) || '').toLowerCase()
    );

  const isPending = o =>
    ['pending', 'processing', 'requested', 'waiting'].includes(
      String((o && (o.status || o.state)) || 'pending').toLowerCase()
    );

  return {
    totalUsers: db.users.length,
    chargedPool: sumKeys(db.users, ['chargedBalance', 'charged']),
    withdrawPool: sumKeys(db.users, ['withdrawBalance', 'withdraw']),
    approvedRecharge: sumKeys(db.recharges.filter(isApproved), ['amount']),
    pendingRechargeCount: db.recharges.filter(isPending).length,
    totalWithdraw: sumKeys(db.withdrawals.filter(isApproved), ['amount']),
    pendingWithdrawCount: db.withdrawals.filter(isPending).length,
    inviteBonus: sumKeys(db.users, ['inviteBonus', 'inviteBonusEarned']),
    activePlans: db.products.length,
    activeInvestments: db.investments.length,
    totalPromos: db.promos.length
  };
}

// ==========================================
// 0. HEALTH & PUBLIC RUNTIME ENDPOINTS
// ==========================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Full Admin & User Backend API',
    storage: USE_SUPABASE ? 'supabase+local' : 'local-json',
    time: nowIso()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    ok: true,
    storage: USE_SUPABASE ? 'supabase+local' : 'local-json',
    time: nowIso()
  });
});

app.get('/api/public/config', async (req, res) => {
  try {
    const db = await loadDb();
    const {
      brandName,
      inviteBonus,
      inviteBonusAmount,
      minWithdraw,
      withdrawFeePercent,
      upiId,
      qrCodeImage,
      customServiceLink,
      popupBanner,
      homeBanner,
      maintenanceMode,
      connectedSite,
      liveCode
    } = db.config;

    res.json({
      success: true,
      config: {
        brandName,
        inviteBonus,
        inviteBonusAmount,
        minWithdraw,
        withdrawFeePercent,
        upiId,
        qrCodeImage,
        customServiceLink,
        popupBanner,
        homeBanner,
        maintenanceMode,
        connectedSite,
        liveCode
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 1. ADMIN STATS & AUDIT LOGS
// ==========================================
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, stats: computeStats(db) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/audit-logs', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, logs: db.auditLogs.slice(0, 200) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    const uid = req.query.uid ? String(req.query.uid).trim() : '';
    const list = uid ? db.transactions.filter(t => String(t.uid) === uid) : db.transactions;
    res.json({ success: true, transactions: list.slice(0, 300) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 2. ADMIN USERS & BONUS
// ==========================================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, users: db.users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users/create', requireAdmin, async (req, res) => {
  try {
    const { uid, phone, invitedBy, chargedBalance, withdrawBalance, vipLevel } = req.body || {};
    const targetUid = String(uid || '').trim() || String(Math.floor(100000 + Math.random() * 900000));
    const db = await loadDb();
    const user = findOrCreateUser(db, targetUid, phone, invitedBy);
    if (chargedBalance !== undefined) user.chargedBalance = roundMoney(chargedBalance);
    if (withdrawBalance !== undefined) user.withdrawBalance = roundMoney(withdrawBalance);
    if (vipLevel !== undefined) user.vipLevel = toNum(vipLevel, 0);
    user.updatedAt = nowIso();
    addAudit(db, 'admin', 'create_or_update_user', { uid: user.uid });
    await saveDb(db);
    res.json({ success: true, message: 'User saved', user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users/status', requireAdmin, async (req, res) => {
  try {
    const { uid, status, vipLevel } = req.body || {};
    if (!uid) return res.status(400).json({ success: false, message: 'uid required' });
    const db = await loadDb();
    const user = db.users.find(u => String(u.uid) === String(uid).trim());
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (status) user.status = String(status).toLowerCase();
    if (vipLevel !== undefined) user.vipLevel = toNum(vipLevel, user.vipLevel);
    user.updatedAt = nowIso();
    addAudit(db, 'admin', 'update_user_status', { uid: user.uid, status: user.status, vipLevel: user.vipLevel });
    await saveDb(db);
    res.json({ success: true, message: 'User updated', user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/bonus/uid', requireAdmin, async (req, res) => {
  try {
    const { uid, amount, balanceTarget, note } = req.body || {};
    const amt = roundMoney(amount);
    if (!uid || !(amt > 0)) {
      return res.status(400).json({ success: false, message: 'Valid uid and positive amount required' });
    }

    const db = await loadDb();
    const user = findOrCreateUser(db, uid);
    const target = String(balanceTarget || 'charged').toLowerCase();

    if (target === 'withdraw') {
      user.withdrawBalance = roundMoney(toNum(user.withdrawBalance, 0) + amt);
      addTransaction(db, {
        uid: user.uid,
        type: 'admin_bonus',
        wallet: 'withdraw',
        amount: amt,
        note: note || 'Admin bonus to withdraw balance'
      });
    } else if (target === 'both') {
      user.chargedBalance = roundMoney(toNum(user.chargedBalance, 0) + amt);
      user.withdrawBalance = roundMoney(toNum(user.withdrawBalance, 0) + amt);
      addTransaction(db, {
        uid: user.uid,
        type: 'admin_bonus',
        wallet: 'both',
        amount: amt,
        note: note || 'Admin bonus to both balances'
      });
    } else {
      user.chargedBalance = roundMoney(toNum(user.chargedBalance, 0) + amt);
      addTransaction(db, {
        uid: user.uid,
        type: 'admin_bonus',
        wallet: 'charged',
        amount: amt,
        note: note || 'Admin bonus to charged balance'
      });
    }

    user.updatedAt = nowIso();
    addAudit(db, 'admin', 'bonus_uid', { uid: user.uid, amount: amt, balanceTarget: target });
    await saveDb(db);

    res.json({ success: true, message: `Bonus ₹${amt} sent to UID ${user.uid}`, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. RECHARGE (ADMIN + USER)
// ==========================================
app.get('/api/admin/recharges', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, recharges: db.recharges });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/recharge/uid', requireAdmin, async (req, res) => {
  try {
    const { uid, amount, channel, phone } = req.body || {};
    const amt = roundMoney(amount);
    if (!uid || !(amt > 0)) {
      return res.status(400).json({ success: false, message: 'Valid uid and amount required' });
    }

    const db = await loadDb();
    const user = findOrCreateUser(db, uid, phone);
    user.chargedBalance = roundMoney(toNum(user.chargedBalance, 0) + amt);
    user.updatedAt = nowIso();

    const record = {
      rechargeId: makeId('REC'),
      uid: user.uid,
      phone: user.phone || phone || '',
      amount: amt,
      channel: channel || 'UPI',
      status: 'approved',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    db.recharges.unshift(record);
    addTransaction(db, {
      uid: user.uid,
      type: 'admin_recharge',
      wallet: 'charged',
      amount: amt,
      note: `Direct recharge via ${record.channel}`
    });
    addAudit(db, 'admin', 'recharge_uid', { uid: user.uid, amount: amt, channel: record.channel });
    await saveDb(db);

    res.json({ success: true, message: `Recharged ₹${amt} to UID ${user.uid}`, recharge: record, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/recharge/action', requireAdmin, async (req, res) => {
  try {
    const { rechargeId, action } = req.body || {};
    const act = String(action || '').toLowerCase();
    if (!rechargeId || !['approve', 'reject'].includes(act)) {
      return res.status(400).json({ success: false, message: 'rechargeId and valid action required' });
    }

    const db = await loadDb();
    const rec = db.recharges.find(r => String(r.rechargeId || r.id || r._id) === String(rechargeId));
    if (!rec) {
      return res.status(404).json({ success: false, message: 'Recharge request not found' });
    }

    const prevStatus = String(rec.status || 'pending').toLowerCase();
    const user = findOrCreateUser(db, rec.uid || rec.userId, rec.phone);
    const amt = roundMoney(rec.amount);

    if (act === 'approve' && prevStatus !== 'approved') {
      user.chargedBalance = roundMoney(toNum(user.chargedBalance, 0) + amt);
      rec.status = 'approved';
      addTransaction(db, {
        uid: user.uid,
        type: 'recharge_approved',
        wallet: 'charged',
        amount: amt,
        note: `Approved recharge ${rec.rechargeId}`
      });
    } else if (act === 'reject') {
      if (prevStatus === 'approved') {
        user.chargedBalance = Math.max(0, roundMoney(toNum(user.chargedBalance, 0) - amt));
      }
      rec.status = 'rejected';
    }

    rec.updatedAt = nowIso();
    user.updatedAt = nowIso();
    addAudit(db, 'admin', `recharge_${act}`, { rechargeId: rec.rechargeId, uid: user.uid, amount: amt });
    await saveDb(db);

    res.json({ success: true, message: `Recharge ${rec.status}`, recharge: rec, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/recharge/request', async (req, res) => {
  try {
    const { uid, phone, amount, channel, utr } = req.body || {};
    const amt = roundMoney(amount);
    if (!uid || !(amt > 0)) {
      return res.status(400).json({ success: false, message: 'uid and positive amount required' });
    }

    const db = await loadDb();
    const user = findOrCreateUser(db, uid, phone);
    const record = {
      rechargeId: makeId('REC'),
      uid: user.uid,
      phone: user.phone || phone || '',
      amount: amt,
      channel: channel || 'UPI',
      utr: String(utr || '').trim(),
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    db.recharges.unshift(record);
    await saveDb(db);

    res.json({ success: true, message: 'Recharge request submitted', recharge: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4. WITHDRAWALS (ADMIN + USER)
// ==========================================
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, withdrawals: db.withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/withdraw/action', requireAdmin, async (req, res) => {
  try {
    const { withdrawalId, action } = req.body || {};
    const act = String(action || '').toLowerCase();
    if (!withdrawalId || !['approve', 'reject'].includes(act)) {
      return res.status(400).json({ success: false, message: 'withdrawalId and valid action required' });
    }

    const db = await loadDb();
    const wd = db.withdrawals.find(w => String(w.withdrawalId || w.id || w._id) === String(withdrawalId));
    if (!wd) {
      return res.status(404).json({ success: false, message: 'Withdrawal request not found' });
    }

    const prevStatus = String(wd.status || 'pending').toLowerCase();
    const user = findOrCreateUser(db, wd.uid || wd.userId, wd.phone);
    const amt = roundMoney(wd.amount);

    if (act === 'approve') {
      wd.status = 'approved';
      addTransaction(db, {
        uid: user.uid,
        type: 'withdraw_approved',
        wallet: 'withdraw',
        amount: amt,
        note: `Approved withdrawal ${wd.withdrawalId}`
      });
    } else if (act === 'reject') {
      if (prevStatus === 'pending' || prevStatus === 'approved') {
        user.withdrawBalance = roundMoney(toNum(user.withdrawBalance, 0) + amt);
        addTransaction(db, {
          uid: user.uid,
          type: 'withdraw_refund',
          wallet: 'withdraw',
          amount: amt,
          note: `Refunded rejected withdrawal ${wd.withdrawalId}`
        });
      }
      wd.status = 'rejected';
    }

    wd.updatedAt = nowIso();
    user.updatedAt = nowIso();
    addAudit(db, 'admin', `withdraw_${act}`, { withdrawalId: wd.withdrawalId, uid: user.uid, amount: amt });
    await saveDb(db);

    res.json({ success: true, message: `Withdrawal ${wd.status}`, withdrawal: wd, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/withdraw/request', async (req, res) => {
  try {
    const { uid, amount, bankName, accountNumber, ifsc, upiId } = req.body || {};
    const amt = roundMoney(amount);
    const minWd = toNum(req.app.locals.minWithdraw, 0);
    if (!uid || !(amt > 0)) {
      return res.status(400).json({ success: false, message: 'uid and positive amount required' });
    }

    const db = await loadDb();
    if (amt < toNum(db.config.minWithdraw, minWd)) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdraw amount is ₹${db.config.minWithdraw}`
      });
    }

    const user = findOrCreateUser(db, uid);
    if (toNum(user.withdrawBalance, 0) < amt) {
      return res.status(400).json({ success: false, message: 'Insufficient withdraw balance' });
    }

    user.withdrawBalance = roundMoney(toNum(user.withdrawBalance, 0) - amt);
    user.updatedAt = nowIso();

    const wd = {
      withdrawalId: makeId('WD'),
      uid: user.uid,
      phone: user.phone || '',
      amount: amt,
      bankName: String(bankName || '').trim(),
      accountNumber: String(accountNumber || '').trim(),
      ifsc: String(ifsc || '').trim().toUpperCase(),
      upiId: String(upiId || '').trim(),
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    db.withdrawals.unshift(wd);
    addTransaction(db, {
      uid: user.uid,
      type: 'withdraw_request',
      wallet: 'withdraw',
      amount: -amt,
      status: 'pending',
      note: `Withdrawal request ${wd.withdrawalId}`
    });
    await saveDb(db);

    res.json({ success: true, message: 'Withdrawal request created', withdrawal: wd, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 5. LIVE CHAT (ADMIN + USER)
// ==========================================
app.get('/api/service/chat/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    const db = await loadDb();
    const messages = Array.isArray(db.chats[userId]) ? db.chats[userId] : [];
    res.json({ success: true, userId, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/service/chat/send', async (req, res) => {
  try {
    const { userId, message, text } = req.body || {};
    const cleanUid = String(userId || '').trim();
    const cleanMsg = String(message ?? text ?? '').trim();
    if (!cleanUid || !cleanMsg) {
      return res.status(400).json({ success: false, message: 'userId and message required' });
    }

    const db = await loadDb();
    findOrCreateUser(db, cleanUid);
    if (!Array.isArray(db.chats[cleanUid])) db.chats[cleanUid] = [];

    const msg = {
      id: makeId('MSG'),
      sender: 'user',
      isAdmin: false,
      message: cleanMsg,
      createdAt: nowIso()
    };
    db.chats[cleanUid].push(msg);
    await saveDb(db);

    res.json({ success: true, message: 'Message sent', chatMessage: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/service/chat/reply', requireAdmin, async (req, res) => {
  try {
    const { userId, reply, message } = req.body || {};
    const cleanUid = String(userId || '').trim();
    const cleanReply = String(reply ?? message ?? '').trim();
    if (!cleanUid || !cleanReply) {
      return res.status(400).json({ success: false, message: 'userId and reply required' });
    }

    const db = await loadDb();
    if (!Array.isArray(db.chats[cleanUid])) db.chats[cleanUid] = [];

    const msg = {
      id: makeId('MSG'),
      sender: 'admin',
      isAdmin: true,
      message: cleanReply,
      createdAt: nowIso()
    };

    db.chats[cleanUid].push(msg);
    addAudit(db, 'admin', 'chat_reply', { userId: cleanUid });
    await saveDb(db);

    res.json({ success: true, message: 'Reply sent', chatMessage: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 6. PRODUCTS / PLANS & INVESTMENTS
// ==========================================
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, products: db.products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, products: db.products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/products/add', requireAdmin, async (req, res) => {
  try {
    const { name, price, dailyIncome, durationDays, vipLevel, payoutInterval, image } = req.body || {};
    const numPrice = roundMoney(price);
    if (!name || !(numPrice > 0)) {
      return res.status(400).json({ success: false, message: 'Plan name and positive price required' });
    }

    const db = await loadDb();
    const product = {
      productId: makeId('PLAN'),
      name: String(name).trim(),
      price: numPrice,
      dailyIncome: roundMoney(dailyIncome || 0),
      durationDays: toNum(durationDays, 0),
      vipLevel: toNum(vipLevel, 1),
      payoutInterval: String(payoutInterval || 'daily'),
      image: String(image || '').trim(),
      createdAt: nowIso()
    };

    db.products.unshift(product);
    addAudit(db, 'admin', 'product_add', { productId: product.productId, name: product.name, price: product.price });
    await saveDb(db);

    res.json({ success: true, message: 'Plan created', product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/products/remove', requireAdmin, async (req, res) => {
  try {
    const { productId } = req.body || {};
    if (!productId) {
      return res.status(400).json({ success: false, message: 'productId required' });
    }

    const db = await loadDb();
    const before = db.products.length;
    db.products = db.products.filter(
      p => String(p.productId || p.id || p._id) !== String(productId)
    );
    if (db.products.length === before) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    addAudit(db, 'admin', 'product_remove', { productId });
    await saveDb(db);

    res.json({ success: true, message: 'Plan removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/products/buy', async (req, res) => {
  try {
    const { uid, productId } = req.body || {};
    if (!uid || !productId) {
      return res.status(400).json({ success: false, message: 'uid and productId required' });
    }

    const db = await loadDb();
    const plan = db.products.find(p => String(p.productId || p.id) === String(productId));
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    const user = findOrCreateUser(db, uid);
    const price = roundMoney(plan.price);
    if (toNum(user.chargedBalance, 0) < price) {
      return res.status(400).json({ success: false, message: 'Insufficient charged balance' });
    }

    user.chargedBalance = roundMoney(toNum(user.chargedBalance, 0) - price);
    user.vipLevel = Math.max(toNum(user.vipLevel, 0), toNum(plan.vipLevel, 0));
    user.updatedAt = nowIso();

    const inv = {
      investmentId: makeId('INV'),
      uid: user.uid,
      productId: plan.productId,
      planName: plan.name,
      price,
      dailyIncome: roundMoney(plan.dailyIncome || 0),
      durationDays: toNum(plan.durationDays, 0),
      status: 'active',
      createdAt: nowIso()
    };

    db.investments.unshift(inv);
    addTransaction(db, {
      uid: user.uid,
      type: 'plan_purchase',
      wallet: 'charged',
      amount: -price,
      note: `Purchased plan ${plan.name}`
    });
    await saveDb(db);

    res.json({ success: true, message: `Purchased ${plan.name}`, investment: inv, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 7. PROMO CODES (ADMIN CREATE + USER REDEEM)
// ==========================================
app.get('/api/admin/promos', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, promos: db.promos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/promo/create', requireAdmin, async (req, res) => {
  try {
    const { code, rewardAmount, balanceTarget, maxUses, expiresAt, requiredVipLevel } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    const reward = roundMoney(rewardAmount);
    if (!cleanCode || !(reward > 0)) {
      return res.status(400).json({ success: false, message: 'Valid promo code and rewardAmount required' });
    }

    const db = await loadDb();
    const promo = {
      id: makeId('PROMO'),
      code: cleanCode,
      rewardAmount: reward,
      balanceTarget: String(balanceTarget || 'charged').toLowerCase(),
      maxUses: toNum(maxUses, 0),
      usedCount: 0,
      expiresAt: expiresAt ? String(expiresAt) : '',
      requiredVipLevel: toNum(requiredVipLevel, 0),
      createdAt: nowIso()
    };

    db.promos.unshift(promo);
    addAudit(db, 'admin', 'promo_create', { code: cleanCode, rewardAmount: reward });
    await saveDb(db);

    res.json({ success: true, message: `Promo ${cleanCode} created`, promo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/promo/redeem', async (req, res) => {
  try {
    const { uid, code } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!uid || !cleanCode) {
      return res.status(400).json({ success: false, message: 'uid and code required' });
    }

    const db = await loadDb();
    const promo = db.promos.find(p => String(p.code).toUpperCase() === cleanCode);
    if (!promo) {
      return res.status(404).json({ success: false, message: 'Invalid promo code' });
    }

    if (promo.expiresAt && Date.now() > new Date(promo.expiresAt).getTime()) {
      return res.status(400).json({ success: false, message: 'Promo code expired' });
    }

    if (promo.maxUses > 0 && toNum(promo.usedCount, 0) >= toNum(promo.maxUses, 0)) {
      return res.status(400).json({ success: false, message: 'Promo code usage limit reached' });
    }

    const alreadyUsed = db.promoRedemptions.some(
      r => String(r.uid) === String(uid).trim() && String(r.code).toUpperCase() === cleanCode
    );
    if (alreadyUsed) {
      return res.status(400).json({ success: false, message: 'Promo already redeemed by this user' });
    }

    const user = findOrCreateUser(db, uid);
    if (toNum(user.vipLevel, 0) < toNum(promo.requiredVipLevel, 0)) {
      return res.status(400).json({
        success: false,
        message: `Requires VIP ${promo.requiredVipLevel}`
      });
    }

    const reward = roundMoney(promo.rewardAmount);
    if (promo.balanceTarget === 'withdraw') {
      user.withdrawBalance = roundMoney(toNum(user.withdrawBalance, 0) + reward);
    } else if (promo.balanceTarget === 'both') {
      user.chargedBalance = roundMoney(toNum(user.chargedBalance, 0) + reward);
      user.withdrawBalance = roundMoney(toNum(user.withdrawBalance, 0) + reward);
    } else {
      user.chargedBalance = roundMoney(toNum(user.chargedBalance, 0) + reward);
    }

    promo.usedCount = toNum(promo.usedCount, 0) + 1;
    user.updatedAt = nowIso();

    db.promoRedemptions.unshift({
      id: makeId('RDM'),
      uid: user.uid,
      code: cleanCode,
      rewardAmount: reward,
      createdAt: nowIso()
    });

    addTransaction(db, {
      uid: user.uid,
      type: 'promo_reward',
      wallet: promo.balanceTarget,
      amount: reward,
      note: `Redeemed promo ${cleanCode}`
    });
    await saveDb(db);

    res.json({ success: true, message: `Redeemed ₹${reward} from ${cleanCode}`, rewardAmount: reward, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 8. LIVE CODE & USER HOST SITE
// ==========================================
app.post('/api/admin/user-site/connect', requireAdmin, async (req, res) => {
  try {
    const { url, forceReload } = req.body || {};
    if (!url) {
      return res.status(400).json({ success: false, message: 'Site url required' });
    }

    const db = await loadDb();
    db.config.connectedSite = {
      url: String(url).trim(),
      forceReload: Boolean(forceReload),
      updatedAt: nowIso()
    };
    addAudit(db, 'admin', 'user_site_connect', { url: db.config.connectedSite.url });
    await saveDb(db);

    res.json({ success: true, message: 'Host site connected', connectedSite: db.config.connectedSite });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/user-code/publish', requireAdmin, async (req, res) => {
  try {
    const { html, css, js, note, forceReload } = req.body || {};
    const db = await loadDb();
    db.config.liveCode = {
      html: String(html || ''),
      css: String(css || ''),
      js: String(js || ''),
      note: String(note || ''),
      forceReload: Boolean(forceReload),
      publishedAt: nowIso()
    };
    addAudit(db, 'admin', 'user_code_publish', { note: db.config.liveCode.note });
    await saveDb(db);

    res.json({ success: true, message: 'Live code published', liveCode: db.config.liveCode });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 9. SETTINGS / CONFIG
// ==========================================
app.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const db = await loadDb();
    res.json({ success: true, config: db.config || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const db = await loadDb();
    const bonus = roundMoney(body.inviteBonusAmount ?? body.inviteBonus ?? db.config.inviteBonusAmount ?? 0);

    db.config = {
      ...db.config,
      brandName: body.brandName !== undefined ? String(body.brandName) : db.config.brandName,
      inviteBonus: bonus,
      inviteBonusAmount: bonus,
      minWithdraw:
        body.minWithdraw !== undefined ? roundMoney(body.minWithdraw) : toNum(db.config.minWithdraw, 100),
      withdrawFeePercent:
        body.withdrawFeePercent !== undefined
          ? roundMoney(body.withdrawFeePercent)
          : toNum(db.config.withdrawFeePercent, 0),
      upiId: body.upiId !== undefined ? String(body.upiId) : db.config.upiId,
      qrCodeImage: body.qrCodeImage !== undefined ? String(body.qrCodeImage) : db.config.qrCodeImage,
      customServiceLink:
        body.customServiceLink !== undefined ? String(body.customServiceLink) : db.config.customServiceLink,
      popupBanner: body.popupBanner !== undefined ? String(body.popupBanner) : db.config.popupBanner,
      homeBanner: body.homeBanner !== undefined ? String(body.homeBanner) : db.config.homeBanner,
      maintenanceMode:
        body.maintenanceMode !== undefined ? Boolean(body.maintenanceMode) : Boolean(db.config.maintenanceMode),
      updatedAt: nowIso()
    };

    addAudit(db, 'admin', 'config_update', { brandName: db.config.brandName, upiId: db.config.upiId });
    await saveDb(db);

    res.json({ success: true, message: 'Configuration saved', config: db.config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 10. 404 & GLOBAL ERROR HANDLER
// ==========================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT} | Storage: ${USE_SUPABASE ? 'Supabase+Local' : 'Local JSON'}`);
});
