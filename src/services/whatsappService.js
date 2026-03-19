const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const pool   = require('../config/db');
const MySQLStore = require('../config/waStore');
const { sendWADisconnectAlert } = require('./emailService');

// Optional: sharp for WebP compression
let sharp = null;
try { sharp = require('sharp'); } catch {
  console.warn('[WA] sharp not installed - pics stored as raw JPEG.');
}

// ─── Resolve Chrome executable path ──────────────────────────────────────────
// On Render, `npx puppeteer browsers install chrome` puts Chrome in a cache dir.
// We create a .puppeteerrc.cjs at project root to pin the cache to a persistent
// directory, AND scan it here as a fallback.
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    const p = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (fs.existsSync(p)) { console.log('[WA] Chrome via env:', p); return p; }
    console.warn('[WA] PUPPETEER_EXECUTABLE_PATH set but file missing:', p);
  }
  try {
    const puppeteer = require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) { console.log('[WA] Chrome via puppeteer pkg:', p); return p; }
  } catch {}
  // Scan all known cache dirs
  const bases = [
    '/opt/render/project/src/.cache/puppeteer/chrome/',
    '/opt/render/.cache/puppeteer/chrome/',
    `${process.env.HOME || '/root'}/.cache/puppeteer/chrome/`,
    '/root/.cache/puppeteer/chrome/',
  ];
  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const dir of fs.readdirSync(base)) {
        const p = `${base}${dir}/chrome-linux64/chrome`;
        if (fs.existsSync(p)) { console.log('[WA] Chrome found:', p); return p; }
      }
    } catch {}
  }
  for (const p of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (fs.existsSync(p)) { console.log('[WA] Chrome system:', p); return p; }
  }
  console.log('[WA] Chrome not found — letting whatsapp-web.js use bundled Chromium');
  return undefined;
}

const CHROME_PATH = resolveChromePath();

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Image helpers ────────────────────────────────────────────────────────────
async function fetchAndCompressImage(url) {
  if (!url) return null;
  let buffer;
  try {
    buffer = await new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': 'https://web.whatsapp.com/',
          'Origin':  'https://web.whatsapp.com',
        },
      }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          res.resume();
          return fetchAndCompressImage(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  } catch (err) {
    console.warn(`[PicFetch] Download failed: ${err.message}`);
    return null;
  }
  if (!buffer || buffer.length < 100) return null;
  if (sharp) {
    try {
      const webp = await sharp(buffer).resize(64, 64, { fit: 'cover' }).webp({ quality: 75 }).toBuffer();
      return `data:image/webp;base64,${webp.toString('base64')}`;
    } catch {}
  }
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

async function getPicUrlForJid(waClient, jid) {
  try {
    if (waClient?.pupPage && !waClient.pupPage.isClosed()) {
      const url = await waClient.pupPage.evaluate(async (id) => {
        try {
          const wid = window.Store.WidFactory.createWid(id);
          const picResult = await window.Store.ProfilePic.profilePicFind(wid);
          if (picResult?.eurl) return picResult.eurl;
          if (picResult?.img)  return picResult.img;
          const contact = window.Store.Contact.get(id);
          if (contact?.profilePicThumbObj?.eurl) return contact.profilePicThumbObj.eurl;
          if (contact?.profilePicThumbObj?.img)  return contact.profilePicThumbObj.img;
          return null;
        } catch { return null; }
      }, jid);
      if (url) return url;
    }
  } catch {}
  try {
    const url = await waClient.getProfilePicUrl(jid);
    if (url) return url;
  } catch {}
  return null;
}

// ─── Per-user client state ────────────────────────────────────────────────────
const userClients = new Map();
let io = null;

function setIO(socketIO) { io = socketIO; }

function getState(userId) {
  if (!userClients.has(userId)) {
    userClients.set(userId, { client: null, status: 'disconnected', qrBase64: null });
  }
  return userClients.get(userId);
}

function getStatus(userId)  { return getState(userId).status; }
function getQR(userId)      { return getState(userId).qrBase64; }
function getClient(userId)  { return getState(userId).client; }

function getAllStatuses() {
  const result = {};
  for (const [uid, state] of userClients.entries()) {
    result[uid] = { status: state.status, hasQR: !!state.qrBase64 };
  }
  return result;
}

function emitToUser(userId, event, data) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, { ...data, userId });
}

async function getUserEmail(userId) {
  try {
    const [rows] = await pool.execute('SELECT email, username FROM users WHERE id = ? LIMIT 1', [userId]);
    return rows[0] || null;
  } catch { return null; }
}

// ─── ACK event handler ────────────────────────────────────────────────────────
async function handleMessageAck(userId, message, ack) {
  try {
    const waMessageId = message.id?._serialized || message.id?.id;
    if (!waMessageId) return;
    const [rows] = await pool.execute(
      'SELECT id, type, ack_status, read_count FROM scheduled_messages WHERE wa_message_id = ? AND user_id = ? LIMIT 1',
      [waMessageId, userId]
    );
    if (rows.length === 0) return;
    const row = rows[0];
    const msgId = row.id;
    const isGroup = row.type === 'group';
    if (isGroup) {
      if (ack >= 3) {
        await pool.execute(
          `UPDATE scheduled_messages SET ack_status = GREATEST(ack_status, ?), read_count = read_count + 1 WHERE id = ?`,
          [ack, msgId]
        );
      } else {
        await pool.execute('UPDATE scheduled_messages SET ack_status = GREATEST(ack_status, ?) WHERE id = ?', [ack, msgId]);
      }
    } else {
      await pool.execute('UPDATE scheduled_messages SET ack_status = ? WHERE id = ?', [ack, msgId]);
    }
    emitToUser(userId, 'wa:message_ack', {
      messageId: msgId, ack,
      readCount: isGroup ? (row.read_count + (ack >= 3 ? 1 : 0)) : undefined,
    });
  } catch (err) {
    console.error(`[WA:${userId}] handleMessageAck error:`, err.message);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initializeClient(userId) {
  const state = getState(userId);
  if (state.client) { console.log(`[WA:${userId}] Client already initialized`); return; }

  state.status = 'initializing';
  emitToUser(userId, 'wa:status', { status: 'initializing', qr: null });

  const store = new MySQLStore(pool, userId);

  // Build puppeteer config — only set executablePath if we actually found Chrome
  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  };
  if (CHROME_PATH) {
    puppeteerConfig.executablePath = CHROME_PATH;
  }

  const clientId = `user-${userId}`;

  const waClient = new Client({
    authStrategy: new RemoteAuth({
      clientId,
      store,
      backupSyncIntervalMs: 60000, // save every 20s — faster for Render
    }),
    puppeteer: puppeteerConfig,
  });

  state.client = waClient;

  // Helper: attempt session save with retries
  async function trySaveSession(label) {
    const tempZip = `RemoteAuth-${clientId}.zip`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await store.save({ session: tempZip });
        console.log(`[WA:${userId}] Session save OK (${label}, attempt ${attempt})`);
        return;
      } catch (err) {
        console.warn(`[WA:${userId}] Session save attempt ${attempt} failed (${label}):`, err.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt));
      }
    }
  }

  waClient.on('qr', async (qr) => {
    try {
      state.qrBase64 = await qrcode.toDataURL(qr);
      state.status   = 'qr_ready';
      emitToUser(userId, 'wa:qr', { qr: state.qrBase64 });
      console.log(`[WA:${userId}] QR code generated`);
    } catch (err) {
      console.error(`[WA:${userId}] QR generation error:`, err.message);
    }
  });

  waClient.on('ready', () => {
    state.status   = 'connected';
    state.qrBase64 = null;
    emitToUser(userId, 'wa:ready', {});
    emitToUser(userId, 'wa:status', { status: 'connected', qr: null });
    console.log(`[WA:${userId}] Client is ready`);
    // Save at 10s and again at 40s to ensure session is persisted
    setTimeout(() => trySaveSession('post-ready-10s'), 10000);
    setTimeout(() => trySaveSession('post-ready-40s'), 40000);
  });

  waClient.on('authenticated', () => {
    console.log(`[WA:${userId}] Authenticated`);
    // wwebjs writes its zip ~5-10s after auth event — try at 8s then 20s
    setTimeout(() => trySaveSession('post-auth-8s'),  8000);
    setTimeout(() => trySaveSession('post-auth-20s'), 20000);
  });

  waClient.on('auth_failure', async (msg) => {
    state.status = 'disconnected';
    state.client = null;
    emitToUser(userId, 'wa:disconnected', { reason: msg });
    console.error(`[WA:${userId}] Auth failure:`, msg);
    const userInfo = await getUserEmail(userId);
    if (userInfo) sendWADisconnectAlert(userInfo.email, userInfo.username, `Auth failure: ${msg}`).catch(() => {});
  });

  waClient.on('disconnected', async (reason) => {
    state.status   = 'disconnected';
    state.qrBase64 = null;
    state.client   = null;
    emitToUser(userId, 'wa:disconnected', { reason });
    console.log(`[WA:${userId}] Disconnected:`, reason);
    const isManual = reason === 'Manual disconnect' || reason === 'LOGOUT';
    if (!isManual) {
      const userInfo = await getUserEmail(userId);
      if (userInfo) sendWADisconnectAlert(userInfo.email, userInfo.username, reason).catch(() => {});
      console.log(`[WA:${userId}] Auto-reconnect in 10s`);
      setTimeout(() => autoReconnectIfSession(userId).catch(() => {}), 10000);
    }
  });

  waClient.on('remote_session_saved', () => console.log(`[WA:${userId}] Remote session saved`));
  waClient.on('message_ack', (message, ack) => {
    if (!message.fromMe) return;
    handleMessageAck(userId, message, ack).catch(() => {});
  });
  waClient.on('error', (err) => console.error(`[WA:${userId}] Client error:`, err?.message || err));

  await waClient.initialize();
  console.log(`[WA:${userId}] Client initialization started`);
}

// ─── Session helpers ──────────────────────────────────────────────────────────
async function hasStoredSession(userId) {
  try {
    const [rows] = await pool.execute('SELECT id FROM wa_sessions WHERE user_id = ? LIMIT 1', [userId]);
    return rows.length > 0;
  } catch { return false; }
}

async function autoReconnectIfSession(userId) {
  const state = getState(userId);
  if (state.client) return;
  let sessionFile = null;
  try {
    const [rows] = await pool.execute('SELECT session_file FROM wa_sessions WHERE user_id = ? LIMIT 1', [userId]);
    if (rows.length === 0) return;
    sessionFile = rows[0].session_file;
  } catch { return; }
  const absPath = require('path').resolve(__dirname, '../../uploads', sessionFile);
  if (!fs.existsSync(absPath)) {
    console.warn(`[WA:${userId}] Session file missing (${absPath}) — clearing stale DB row`);
    pool.execute('DELETE FROM wa_sessions WHERE user_id = ?', [userId]).catch(() => {});
    return;
  }
  console.log(`[WA:${userId}] Stored session found — auto-reconnecting...`);
  initializeClient(userId).catch(err => console.error(`[WA:${userId}] Auto-reconnect error:`, err.message));
}

async function reconnectAllSessionsOnStartup() {
  try {
    const [rows] = await pool.execute('SELECT DISTINCT user_id FROM wa_sessions');
    if (rows.length === 0) { console.log('[WA] No stored sessions on startup'); return; }
    console.log(`[WA] Startup: reconnecting ${rows.length} session(s)...`);
    for (let i = 0; i < rows.length; i++) {
      const userId = rows[i].user_id;
      setTimeout(() => autoReconnectIfSession(userId).catch(() => {}), i * 3000);
    }
  } catch (err) {
    console.error('[WA] reconnectAllSessionsOnStartup failed:', err.message);
  }
}

// ─── Disconnect ───────────────────────────────────────────────────────────────
async function disconnectClient(userId) {
  const state = getState(userId);
  if (!state.client) return;
  try { await state.client.destroy(); } catch (err) { console.error(`[WA:${userId}] Destroy error:`, err.message); }
  state.client   = null;
  state.status   = 'disconnected';
  state.qrBase64 = null;
  emitToUser(userId, 'wa:disconnected', { reason: 'Manual disconnect' });
}

// ─── Sync groups ──────────────────────────────────────────────────────────────
async function syncGroups(userId) {
  const state = getState(userId);
  if (!state.client || state.status !== 'connected') throw new Error('WhatsApp is not connected for this user');
  const chats  = await state.client.getChats();
  const groups = chats.filter(c => c.isGroup);
  console.log(`[WA:${userId}] Syncing ${groups.length} groups...`);
  let myWid = null;
  try { myWid = state.client.info.wid.user; } catch {}
  let picCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const group   = groups[i];
    const picUrl  = await getPicUrlForJid(state.client, group.id._serialized);
    const picData = await fetchAndCompressImage(picUrl);
    if (picData) picCount++;
    await pool.execute(
      `INSERT INTO wa_groups (user_id, group_jid, name, participants_count, profile_pic_url)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), participants_count = VALUES(participants_count), profile_pic_url = VALUES(profile_pic_url), last_synced = NOW()`,
      [userId, group.id._serialized, group.name, group.participants?.length || 0, picData]
    );
    if (group.participants?.length > 0) {
      try {
        await pool.execute('DELETE FROM wa_group_members WHERE user_id = ? AND group_jid = ?', [userId, group.id._serialized]);
        const memberRows = group.participants
          .filter(p => !p.isMe && (!myWid || p.id.user !== myWid))
          .map(p => [userId, group.id._serialized, p.id.user]);
        if (memberRows.length > 0) {
          const ph = memberRows.map(() => '(?,?,?)').join(',');
          await pool.execute(`INSERT IGNORE INTO wa_group_members (user_id, group_jid, phone) VALUES ${ph}`, memberRows.flat());
        }
      } catch (err) {
        console.warn(`[WA:${userId}] group_members error:`, err.message);
      }
    }
    if ((i + 1) % 5 === 0) await sleep(200);
  }
  console.log(`[WA:${userId}] Synced ${groups.length} groups (${picCount} with pics)`);
  return groups.length;
}

// ─── Sync contacts ────────────────────────────────────────────────────────────
async function syncContacts(userId) {
  const state = getState(userId);
  if (!state.client || state.status !== 'connected') throw new Error('WhatsApp is not connected for this user');
  const contacts     = await state.client.getContacts();
  const realContacts = contacts.filter(c => c.id?.server === 'c.us' && !c.isMe && c.isMyContact === true && (c.name || c.pushname || c.shortName));
  console.log(`[WA:${userId}] Syncing ${realContacts.length} contacts...`);
  const CHUNK = 200;
  let synced  = 0;
  for (let i = 0; i < realContacts.length; i += CHUNK) {
    const batch        = realContacts.slice(i, i + CHUNK);
    const placeholders = batch.map(() => '(?, ?, ?, NULL, NOW())').join(', ');
    const values       = [];
    for (const c of batch) {
      values.push(userId, c.id.user, c.name || c.pushname || c.shortName || c.id.user);
    }
    try {
      await pool.execute(
        `INSERT INTO wa_contacts (user_id, phone, name, profile_pic_url, last_synced) VALUES ${placeholders} ON DUPLICATE KEY UPDATE name = VALUES(name), last_synced = NOW()`,
        values
      );
      synced += batch.length;
    } catch (err) {
      console.error(`[WA:${userId}] Batch upsert error at offset ${i}:`, err.message);
    }
  }
  console.log(`[WA:${userId}] Sync complete — ${synced} contacts`);
  return synced;
}

module.exports = {
  setIO, getStatus, getQR, getClient, getAllStatuses,
  initializeClient, disconnectClient, hasStoredSession,
  autoReconnectIfSession, reconnectAllSessionsOnStartup,
  syncGroups, syncContacts,
};