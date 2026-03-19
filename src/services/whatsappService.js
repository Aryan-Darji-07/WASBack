const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const https  = require('https');
const http   = require('http');
const pool   = require('../config/db');
const MySQLStore = require('../config/waStore');
const { sendWADisconnectAlert } = require('./emailService');

// Optional: sharp for WebP compression. Falls back to raw JPEG if not installed.
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('[WA] sharp not installed - pics stored as raw JPEG. Run: npm install sharp');
}

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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    console.warn(`[PicFetch] Download failed: ${err.message} | URL: ${url?.substring(0, 80)}`);
    return null;
  }

  if (!buffer || buffer.length < 100) return null;

  if (sharp) {
    try {
      const webp = await sharp(buffer)
        .resize(64, 64, { fit: 'cover', position: 'centre' })
        .webp({ quality: 75 })
        .toBuffer();
      return `data:image/webp;base64,${webp.toString('base64')}`;
    } catch { /* fall through to raw */ }
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
  } catch { /* ignore — fall through */ }

  try {
    const url = await waClient.getProfilePicUrl(jid);
    if (url) return url;
  } catch { /* ignore */ }

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

function getStatus(userId)   { return getState(userId).status; }
function getQR(userId)       { return getState(userId).qrBase64; }
function getClient(userId)   { return getState(userId).client; }

function getAllStatuses() {
  const result = {};
  for (const [uid, state] of userClients.entries()) {
    result[uid] = { status: state.status, hasQR: !!state.qrBase64 };
  }
  return result;
}

// ─── Socket helpers ───────────────────────────────────────────────────────────

function emitToUser(userId, event, data) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, { ...data, userId });
}

// ─── Email helper ─────────────────────────────────────────────────────────────

async function getUserEmail(userId) {
  try {
    const [rows] = await pool.execute(
      'SELECT email, username FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
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

    const row     = rows[0];
    const msgId   = row.id;
    const isGroup = row.type === 'group';

    if (isGroup) {
      if (ack >= 3) {
        await pool.execute(
          `UPDATE scheduled_messages
           SET ack_status = GREATEST(ack_status, ?), read_count = read_count + 1
           WHERE id = ?`,
          [ack, msgId]
        );
      } else {
        await pool.execute(
          'UPDATE scheduled_messages SET ack_status = GREATEST(ack_status, ?) WHERE id = ?',
          [ack, msgId]
        );
      }
    } else {
      await pool.execute(
        'UPDATE scheduled_messages SET ack_status = ? WHERE id = ?',
        [ack, msgId]
      );
    }

    emitToUser(userId, 'wa:message_ack', {
      messageId: msgId,
      ack,
      readCount: isGroup ? (row.read_count + (ack >= 3 ? 1 : 0)) : undefined,
    });
  } catch (err) {
    console.error(`[WA:${userId}] handleMessageAck error:`, err.message);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initializeClient(userId) {
  const state = getState(userId);

  if (state.client) {
    console.log(`[WA:${userId}] Client already initialized`);
    return;
  }

  state.status = 'initializing';
  emitToUser(userId, 'wa:status', { status: 'initializing', qr: null });

  const store = new MySQLStore(pool, userId);

  const waClient = new Client({
    authStrategy: new RemoteAuth({
      clientId: `user-${userId}`,
      store,
      backupSyncIntervalMs: 60000, // save session every 1 min
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
    },
  });

  state.client = waClient;

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
    console.log(`[WA:${userId}] Client is ready`);

    // Extra safety net: force a session save 30 s after ready in case
    // the post-auth save at 15 s was too early (zip not written yet).
    setTimeout(async () => {
      try {
        const clientId = `user-${userId}`;
        const tempZip  = `RemoteAuth-${clientId}.zip`;
        await store.save({ session: tempZip });
        console.log(`[WA:${userId}] Post-ready session save OK`);
      } catch (saveErr) {
        console.warn(`[WA:${userId}] Post-ready session save skipped:`, saveErr.message);
      }
    }, 30000);
  });

  waClient.on('authenticated', () => {
    console.log(`[WA:${userId}] Authenticated — scheduling immediate session save`);
    // Force a session backup ~15 s after auth so the session is on disk
    // before the first 1-min interval fires. wwebjs needs ~10 s to write
    // its own zip, then we call store.save() on top of it.
    setTimeout(async () => {
      try {
        const clientId = `user-${userId}`;
        const tempZip  = `RemoteAuth-${clientId}.zip`;
        await store.save({ session: tempZip });
        console.log(`[WA:${userId}] Post-auth immediate session save OK`);
      } catch (saveErr) {
        // Non-fatal — 1-min interval will catch it
        console.warn(`[WA:${userId}] Post-auth save skipped (zip not ready yet):`, saveErr.message);
      }
    }, 15000);
  });

  // ─── Auth failure ─────────────────────────────────────────────────────────
  waClient.on('auth_failure', async (msg) => {
    state.status  = 'disconnected';
    state.client  = null;
    emitToUser(userId, 'wa:disconnected', { reason: msg });
    console.error(`[WA:${userId}] Auth failure:`, msg);

    const userInfo = await getUserEmail(userId);
    if (userInfo) {
      sendWADisconnectAlert(userInfo.email, userInfo.username, `Auth failure: ${msg}`)
        .catch(err => console.error(`[WA:${userId}] Disconnect email failed:`, err.message));
    }
  });

  // ─── Disconnected — alert for unexpected disconnects, then auto-reconnect ────
  waClient.on('disconnected', async (reason) => {
    state.status   = 'disconnected';
    state.qrBase64 = null;
    state.client   = null;
    emitToUser(userId, 'wa:disconnected', { reason });
    console.log(`[WA:${userId}] Disconnected:`, reason);

    const isManual = reason === 'Manual disconnect' || reason === 'LOGOUT';

    if (!isManual) {
      const userInfo = await getUserEmail(userId);
      if (userInfo) {
        sendWADisconnectAlert(userInfo.email, userInfo.username, reason)
          .catch(err => console.error(`[WA:${userId}] Disconnect email failed:`, err.message));
      }

      // Auto-reconnect after 10 s if the user still has a stored session.
      // Handles: network blips, WA server kicks, Puppeteer crashes, etc.
      console.log(`[WA:${userId}] Unexpected disconnect — attempting auto-reconnect in 10 s`);
      setTimeout(() => {
        autoReconnectIfSession(userId).catch(err =>
          console.error(`[WA:${userId}] Post-disconnect auto-reconnect error:`, err.message)
        );
      }, 10000);
    }
  });

  waClient.on('remote_session_saved', () => {
    console.log(`[WA:${userId}] Remote session saved to disk + DB`);
  });

  waClient.on('message_ack', (message, ack) => {
    if (!message.fromMe) return;
    handleMessageAck(userId, message, ack).catch(() => {});
  });

  waClient.on('error', (err) => {
    console.error(`[WA:${userId}] Client error:`, err?.message || err);
  });

  await waClient.initialize();
  console.log(`[WA:${userId}] Client initialization started`);
}

// ─── Session helpers ──────────────────────────────────────────────────────────

async function hasStoredSession(userId) {
  try {
    const [rows] = await pool.execute(
      'SELECT id FROM wa_sessions WHERE user_id = ? LIMIT 1',
      [userId]
    );
    return rows.length > 0;
  } catch { return false; }
}

/**
 * If the user has a saved session (DB row + gz file on disk) but no active
 * in-memory client, auto-start the client.
 * Also verifies the .gz file exists so we never loop on a stale DB row.
 */
async function autoReconnectIfSession(userId) {
  const state = getState(userId);
  if (state.client) return; // already running

  let sessionFile = null;
  try {
    const [rows] = await pool.execute(
      'SELECT session_file FROM wa_sessions WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (rows.length === 0) return;
    sessionFile = rows[0].session_file;
  } catch { return; }

  // Verify gz file actually exists on disk — avoids looping on a stale DB row
  const nodePath = require('path');
  const fs       = require('fs');
  const absPath  = nodePath.resolve(__dirname, '../../uploads', sessionFile);
  if (!fs.existsSync(absPath)) {
    console.warn(`[WA:${userId}] Session file missing on disk (${absPath}) — clearing stale DB row`);
    pool.execute('DELETE FROM wa_sessions WHERE user_id = ?', [userId]).catch(() => {});
    return;
  }

  console.log(`[WA:${userId}] Stored session found — auto-reconnecting...`);
  initializeClient(userId).catch(err =>
    console.error(`[WA:${userId}] Auto-reconnect error:`, err.message)
  );
}

/**
 * Called once at server startup — reconnects every user that has a saved session.
 * Staggers reconnects by 3 s to avoid hammering Puppeteer all at once.
 */
async function reconnectAllSessionsOnStartup() {
  try {
    const [rows] = await pool.execute(
      'SELECT DISTINCT user_id FROM wa_sessions'
    );
    if (rows.length === 0) {
      console.log('[WA] No stored sessions — nothing to reconnect on startup');
      return;
    }

    console.log(`[WA] Startup: reconnecting ${rows.length} user session(s)...`);

    for (let i = 0; i < rows.length; i++) {
      const userId = rows[i].user_id;
      // Stagger each client by 3 seconds so Puppeteer isn't overwhelmed
      setTimeout(() => {
        autoReconnectIfSession(userId).catch(err =>
          console.error(`[WA:${userId}] Startup reconnect error:`, err.message)
        );
      }, i * 3000);
    }
  } catch (err) {
    console.error('[WA] reconnectAllSessionsOnStartup failed:', err.message);
  }
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

async function disconnectClient(userId) {
  const state = getState(userId);
  if (!state.client) return;

  try {
    await state.client.destroy();
  } catch (err) {
    console.error(`[WA:${userId}] Destroy error:`, err.message);
  }

  state.client   = null;
  state.status   = 'disconnected';
  state.qrBase64 = null;
  emitToUser(userId, 'wa:disconnected', { reason: 'Manual disconnect' });
}

// ─── Sync groups ──────────────────────────────────────────────────────────────

async function syncGroups(userId) {
  const state = getState(userId);
  if (!state.client || state.status !== 'connected') {
    throw new Error('WhatsApp is not connected for this user');
  }

  const chats  = await state.client.getChats();
  const groups = chats.filter(c => c.isGroup);

  console.log(`[WA:${userId}] Syncing ${groups.length} groups with profile pics...`);

  let myWid = null;
  try { myWid = state.client.info.wid.user; } catch { /* ignore */ }

  let picCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const group  = groups[i];
    const picUrl  = await getPicUrlForJid(state.client, group.id._serialized);
    const picData = await fetchAndCompressImage(picUrl);
    if (picData) picCount++;

    await pool.execute(
      `INSERT INTO wa_groups (user_id, group_jid, name, participants_count, profile_pic_url)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         participants_count = VALUES(participants_count),
         profile_pic_url = VALUES(profile_pic_url),
         last_synced = NOW()`,
      [userId, group.id._serialized, group.name, group.participants?.length || 0, picData]
    );

    if (group.participants?.length > 0) {
      try {
        await pool.execute(
          'DELETE FROM wa_group_members WHERE user_id = ? AND group_jid = ?',
          [userId, group.id._serialized]
        );
        const memberRows = group.participants
          .filter(p => !p.isMe && (!myWid || p.id.user !== myWid))
          .map(p => [userId, group.id._serialized, p.id.user]);
        if (memberRows.length > 0) {
          const ph = memberRows.map(() => '(?,?,?)').join(',');
          await pool.execute(
            `INSERT IGNORE INTO wa_group_members (user_id, group_jid, phone) VALUES ${ph}`,
            memberRows.flat()
          );
        }
      } catch (err) {
        console.warn(`[WA:${userId}] wa_group_members save error for ${group.id._serialized}:`, err.message);
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
  if (!state.client || state.status !== 'connected') {
    throw new Error('WhatsApp is not connected for this user');
  }

  const contacts     = await state.client.getContacts();
  const realContacts = contacts.filter(c =>
    c.id?.server === 'c.us' &&
    !c.isMe &&
    c.isMyContact === true &&
    (c.name || c.pushname || c.shortName)
  );

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
        `INSERT INTO wa_contacts (user_id, phone, name, profile_pic_url, last_synced)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE name = VALUES(name), last_synced = NOW()`,
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
  setIO,
  getStatus,
  getQR,
  getClient,
  getAllStatuses,
  initializeClient,
  disconnectClient,
  hasStoredSession,
  autoReconnectIfSession,
  reconnectAllSessionsOnStartup,   // ← NEW export
  syncGroups,
  syncContacts,
};