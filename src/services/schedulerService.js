const cron = require('node-cron');
const path = require('path');
const pool = require('../config/db');
const waService = require('./whatsappService');
const { sendScheduledMessageFailedAlert, sendWADisconnectAlert } = require('./emailService');

function emitToUser(userId, event, data) {
  try { const { io } = require('../app'); if (io) io.to(`user:${userId}`).emit(event, { ...data, userId }); } catch {}
}

let schedulerTask = null;

// ─── Helper: fetch user email/username for alerts ─────────────────────────────

async function getUserInfo(userId) {
  try {
    const [rows] = await pool.execute(
      'SELECT email, username FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    return rows[0] || null;
  } catch { return null; }
}

// ─── Puppeteer health check ───────────────────────────────────────────────────

async function isPupPageAlive(waClient) {
  try {
    if (!waClient?.pupPage || waClient.pupPage.isClosed()) return false;
    await waClient.pupPage.evaluate(() => true);
    return true;
  } catch { return false; }
}

async function safeWACall(fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('detached Frame') || msg.includes('Execution context was destroyed')) {
      throw new Error('WA_DETACHED_FRAME: WhatsApp page refreshed mid-send. Message will be retried next cycle.');
    }
    throw err;
  }
}

// ─── Core send logic ──────────────────────────────────────────────────────────

async function sendMessage(waClient, msg) {
  const { MessageMedia } = require('whatsapp-web.js');

  if (msg.type === 'status') {
    await safeWACall(() =>
      waClient.pupPage.evaluate(async () => {
        try {
          const wid = window.Store.WidFactory.createWid('status@broadcast');
          if (!window.Store.Chat.get(wid)) {
            await window.Store.FindOrCreateChat.findOrCreateLatestChat(wid);
          }
        } catch (_) { /* ignore */ }
      })
    ).catch(() => {});

    let result;
    if (msg.media_path) {
      const mediaFullPath = path.resolve(__dirname, '../../uploads', msg.media_path);
      const media = MessageMedia.fromFilePath(mediaFullPath);
      result = await safeWACall(() =>
        waClient.sendMessage('status@broadcast', media, { caption: msg.message_body || '' })
      );
    } else {
      result = await safeWACall(() =>
        waClient.sendMessage('status@broadcast', msg.message_body || '')
      );
    }

    if (!result) {
      throw new Error('Status post returned null - status@broadcast chat could not be loaded.');
    }
    return null;
  }

  let recipientJid;
  if (msg.type === 'group') {
    recipientJid = msg.recipient;
  } else {
    const phone = msg.recipient.replace(/\D/g, '');
    recipientJid = `${phone}@c.us`;
  }

  let result;
  if (msg.media_path) {
    const mediaFullPath = path.resolve(__dirname, '../../uploads', msg.media_path);
    const media = MessageMedia.fromFilePath(mediaFullPath);
    result = await safeWACall(() =>
      waClient.sendMessage(recipientJid, media, {
        caption: msg.message_body || '',
        sendMediaAsDocument: msg.media_type === 'document',
      })
    );
  } else {
    result = await safeWACall(() =>
      waClient.sendMessage(recipientJid, msg.message_body)
    );
  }

  return result || null;
}

// ─── Helper: get group participant count ──────────────────────────────────────

async function getGroupParticipantCount(waClient, groupJid) {
  try {
    const chat = await waClient.getChatById(groupJid);
    return chat?.participants?.length || 0;
  } catch { return 0; }
}

// ─── Track users who already got a "disconnected" email this cycle ────────────
// Prevents sending the same disconnect email multiple times per scheduler run
// when a user has several pending messages and WA is down for all of them.
const _disconnectEmailedThisRun = new Set();

// ─── Scheduler ────────────────────────────────────────────────────────────────

async function processMessages() {
  _disconnectEmailedThisRun.clear();

  // ─── Auto-fail messages that are 30+ minutes past their scheduled time ────
  try {
    const [expired] = await pool.execute(
      `SELECT id, user_id, recipient, type, scheduled_at FROM scheduled_messages
       WHERE status = 'pending'
         AND scheduled_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)`
    );

    if (expired.length > 0) {
      const errorMsg = 'WhatsApp was not connected at scheduled time - message expired after 30 min';

      await pool.execute(
        `UPDATE scheduled_messages
         SET status = 'failed', error_message = ?
         WHERE status = 'pending'
           AND scheduled_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)`,
        [errorMsg]
      );
      console.log(`[Scheduler] Auto-failed ${expired.length} stale message(s)`);

      const byUser = {};
      for (const row of expired) {
        if (!byUser[row.user_id]) byUser[row.user_id] = [];
        byUser[row.user_id].push(row);
      }

      for (const [userIdStr, msgs] of Object.entries(byUser)) {
        const userId = parseInt(userIdStr);
        emitToUser(userId, 'wa:message_failed', { messageId: null, error: errorMsg, bulk: true });

        const userInfo = await getUserInfo(userId);
        if (userInfo) {
          for (const msg of msgs) {
            await sendScheduledMessageFailedAlert(userInfo.email, userInfo.username, {
              id:            msg.id,
              recipient:     msg.recipient,
              type:          msg.type,
              scheduled_at:  msg.scheduled_at,
              error_message: errorMsg,
            }).catch(() => {});
          }
        }
      }
    }
  } catch (expireErr) {
    console.error('[Scheduler] Stale expiry check failed:', expireErr.message);
  }

  // ─── Fetch all messages due now ───────────────────────────────────────────
  let messages;
  try {
    [messages] = await pool.execute(
      `SELECT * FROM scheduled_messages
       WHERE status = 'pending' AND scheduled_at <= UTC_TIMESTAMP()
       ORDER BY user_id ASC, scheduled_at ASC`
    );
  } catch (err) {
    console.error('[Scheduler] DB query error:', err.message);
    return;
  }

  if (messages.length === 0) {
    console.log('[Scheduler] No pending messages due at', new Date().toISOString());
    return;
  }

  const byUser = {};
  for (const msg of messages) {
    if (!byUser[msg.user_id]) byUser[msg.user_id] = [];
    byUser[msg.user_id].push(msg);
  }

  console.log(`[Scheduler] Processing ${messages.length} message(s) for ${Object.keys(byUser).length} user(s)`);

  for (const [userIdStr, userMessages] of Object.entries(byUser)) {
    const userId   = parseInt(userIdStr);
    const waClient = waService.getClient(userId);
    const waStatus = waService.getStatus(userId);

    // ── FIX #2: Email user when WA is disconnected and messages are skipped ──
    if (!waClient || waStatus !== 'connected') {
      console.log(`[Scheduler] User ${userId}: WhatsApp not connected — skipping ${userMessages.length} message(s)`);

      for (const msg of userMessages) {
        await pool.execute(
          `UPDATE scheduled_messages
           SET error_message = CONCAT(COALESCE(error_message, ''), '[Skipped: WA disconnected at ', UTC_TIMESTAMP(), '] ')
           WHERE id = ? AND status = 'pending'`,
          [msg.id]
        ).catch(() => {});
      }

      // Send ONE disconnect alert email per user per scheduler run
      // (not one per message — that would be spammy)
      if (!_disconnectEmailedThisRun.has(userId)) {
        _disconnectEmailedThisRun.add(userId);
        const userInfo = await getUserInfo(userId);
        if (userInfo) {
          const skippedCount = userMessages.length;
          const reason = `WhatsApp is disconnected. ${skippedCount} scheduled message(s) were skipped in this run.`;
          sendWADisconnectAlert(userInfo.email, userInfo.username, reason)
            .catch(() => {});
        }
      }

      continue;
    }

    const pageAlive = await isPupPageAlive(waClient);
    if (!pageAlive) {
      console.warn(`[Scheduler] User ${userId}: Puppeteer page detached — skipping run`);
      continue;
    }

    let userInfo = null;

    for (const msg of userMessages) {
      const stillAlive = await isPupPageAlive(waClient);
      if (!stillAlive) {
        console.warn(`[Scheduler] User ${userId}: Page detached mid-loop — message ${msg.id} will retry`);
        break;
      }

      try {
        console.log(`[Scheduler] User ${userId}: Sending msg id=${msg.id} type=${msg.type} recipient=${msg.recipient}`);
        const waResult = await sendMessage(waClient, msg);

        const waMessageId = waResult?.id?._serialized || waResult?.id?.id || null;

        let totalRecipients = 0;
        if (msg.type === 'group' && msg.recipient) {
          const count = await getGroupParticipantCount(waClient, msg.recipient);
          totalRecipients = Math.max(0, count - 1);
        }

        await pool.execute(
          `UPDATE scheduled_messages
           SET status = 'sent',
               sent_at = UTC_TIMESTAMP(),
               error_message = NULL,
               wa_message_id = ?,
               ack_status = 1,
               total_recipients = ?
           WHERE id = ?`,
          [waMessageId, totalRecipients, msg.id]
        );
        console.log(`[Scheduler] User ${userId}: Message ${msg.id} sent (wa_id=${waMessageId})`);
        emitToUser(userId, 'wa:message_sent', {
          messageId: msg.id,
          sentAt: new Date().toISOString(),
          waMessageId,
          totalRecipients,
        });

      } catch (err) {
        const errMsg = String(err?.message || err || 'Unknown error').substring(0, 500);

        if (errMsg.startsWith('WA_DETACHED_FRAME')) {
          console.warn(`[Scheduler] User ${userId}: Message ${msg.id} skipped (detached frame) — will retry`);
          break;
        }

        await pool.execute(
          `UPDATE scheduled_messages SET status = 'failed', error_message = ? WHERE id = ?`,
          [errMsg, msg.id]
        );
        console.error(`[Scheduler] User ${userId}: Message ${msg.id} failed:`, errMsg);
        emitToUser(userId, 'wa:message_failed', { messageId: msg.id, error: errMsg });

        if (!userInfo) userInfo = await getUserInfo(userId);
        if (userInfo) {
          sendScheduledMessageFailedAlert(userInfo.email, userInfo.username, {
            id:            msg.id,
            recipient:     msg.recipient,
            type:          msg.type,
            scheduled_at:  msg.scheduled_at,
            error_message: errMsg,
          }).catch(() => {});
        }
      }
    }
  }
}

function startScheduler() {
  if (schedulerTask) {
    console.log('[Scheduler] Already running');
    return;
  }

  schedulerTask = cron.schedule('* * * * *', async () => {
    await processMessages();
  });

  console.log('[Scheduler] Started — running every minute');
}

function stopScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    console.log('[Scheduler] Stopped');
  }
}

module.exports = { startScheduler, stopScheduler, processMessages, sendMessage };