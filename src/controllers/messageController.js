const moment = require('moment-timezone');
const pool = require('../config/db');
const { getMediaType } = require('../middleware/upload');
const { processMessages, sendMessage } = require('../services/schedulerService');
const { getClient, getStatus } = require('../services/whatsappService');

async function listMessages(req, res) {
  try {
    const { status, type, ack_read, page = 1, limit = 20, date_from, date_to } = req.query;
    const limitInt  = parseInt(limit);
    const offsetInt = (parseInt(page) - 1) * limitInt;
    const filterRead = ack_read === 'true';

    const conditions = [];
    const params     = [];

    // Always scope to the authenticated user
    conditions.push('sm.user_id = ?');
    params.push(req.user.id);

    if (status) {
      conditions.push('sm.status = ?');
      params.push(status);
    }
    if (type && ['individual', 'group', 'status'].includes(type)) {
      conditions.push('sm.type = ?');
      params.push(type);
    }
    if (filterRead) {
      conditions.push('sm.ack_status >= 3');
    }
    if (date_from) {
      conditions.push('sm.scheduled_at >= ?');
      params.push(date_from);
    }
    if (date_to) {
      conditions.push('sm.scheduled_at <= ?');
      params.push(date_to);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const mainQuery = `
      SELECT sm.*,
             u.username, u.timezone as owner_timezone,
             CASE
               WHEN sm.type = 'group'      THEN COALESCE(wg.name, sm.recipient)
               WHEN sm.type = 'individual' THEN COALESCE(wc.name, sm.recipient)
               ELSE NULL
             END AS recipient_name
      FROM scheduled_messages sm
      JOIN users u ON sm.user_id = u.id
      LEFT JOIN wa_groups   wg ON wg.group_jid = sm.recipient AND wg.user_id = sm.user_id
      LEFT JOIN wa_contacts wc ON wc.phone     = sm.recipient AND wc.user_id = sm.user_id
      ${whereClause}
      ORDER BY sm.scheduled_at DESC
      LIMIT ${limitInt} OFFSET ${offsetInt}
    `;

    // Use pool.query (not execute) — LIMIT/OFFSET must be inlined, not placeholders
    const [rows] = await pool.query(mainQuery, params);

    // Count query
    const countQuery = `SELECT COUNT(*) as total FROM scheduled_messages sm ${whereClause}`;
    const [[{ total }]] = await pool.query(countQuery, params);

    // Per-type counts for the active status tab
    let typeCounts = { individual: 0, group: 0, status: 0 };
    if (status) {
      const tcConditions = ['sm.user_id = ?', 'sm.status = ?'];
      const tcParams     = [req.user.id, status];
      const tcWhere      = 'WHERE ' + tcConditions.join(' AND ');
      const [tcRows] = await pool.query(
        `SELECT sm.type, COUNT(*) as cnt FROM scheduled_messages sm ${tcWhere} GROUP BY sm.type`,
        tcParams
      );
      tcRows.forEach(r => { typeCounts[r.type] = r.cnt; });
    }

    res.json({
      messages: rows,
      pagination: {
        total,
        page:  parseInt(page),
        limit: limitInt,
        pages: Math.ceil(total / limitInt),
      },
      typeCounts,
    });
  } catch (err) {
    console.error('[listMessages]', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function createMessage(req, res) {
  try {
    const { recipient, message_body, type, scheduled_at, user_timezone } = req.body;

    if (!type || !['individual', 'group', 'status'].includes(type)) {
      return res.status(400).json({ message: 'Invalid type. Must be individual, group, or status.' });
    }
    if (type !== 'status' && !recipient) {
      return res.status(400).json({ message: 'recipient is required for individual/group messages' });
    }
    if (!scheduled_at) {
      return res.status(400).json({ message: 'scheduled_at is required' });
    }

    const tz = user_timezone || req.user.timezone || process.env.DEFAULT_TIMEZONE;
    const scheduledUtc = moment.tz(scheduled_at, tz).utc().format('YYYY-MM-DD HH:mm:ss');

    if (moment.utc(scheduledUtc).isBefore(moment.utc())) {
      return res.status(400).json({ message: 'scheduled_at must be in the future' });
    }

    let mediaPath = null, mediaType = null, mediaFilename = null;
    if (req.file) {
      mediaPath     = req.file.filename;
      mediaType     = getMediaType(req.file.mimetype);
      mediaFilename = req.file.originalname;
    }

    const [result] = await pool.execute(
      `INSERT INTO scheduled_messages
       (user_id, recipient, message_body, media_path, media_type, media_filename, type, scheduled_at, user_timezone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, recipient || null, message_body || null, mediaPath, mediaType, mediaFilename, type, scheduledUtc, tz]
    );

    res.status(201).json({ message: 'Scheduled successfully', id: result.insertId });
  } catch (err) {
    console.error('[createMessage]', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function updateMessage(req, res) {
  try {
    const { id } = req.params;
    const { recipient, message_body, scheduled_at, user_timezone } = req.body;

    const [rows] = await pool.execute('SELECT * FROM scheduled_messages WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Message not found' });

    const msg = rows[0];
    if (req.user.role !== 'admin' && msg.user_id !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (msg.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending messages can be edited' });
    }

    const tz = user_timezone || msg.user_timezone;
    const scheduledUtc = scheduled_at
      ? moment.tz(scheduled_at, tz).utc().format('YYYY-MM-DD HH:mm:ss')
      : null;

    const fields = [], values = [];
    if (recipient !== undefined)    { fields.push('recipient = ?');    values.push(recipient); }
    if (message_body !== undefined) { fields.push('message_body = ?'); values.push(message_body); }
    if (scheduledUtc)               { fields.push('scheduled_at = ?'); values.push(scheduledUtc); }
    if (user_timezone)              { fields.push('user_timezone = ?'); values.push(user_timezone); }

    if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });

    values.push(id);
    await pool.execute(`UPDATE scheduled_messages SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Updated successfully' });
  } catch (err) {
    console.error('[updateMessage]', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function deleteMessage(req, res) {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM scheduled_messages WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Message not found' });

    const msg = rows[0];
    if (req.user.role !== 'admin' && msg.user_id !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (msg.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending messages can be deleted' });
    }

    await pool.execute('DELETE FROM scheduled_messages WHERE id = ?', [id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    console.error('[deleteMessage]', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function sendNow(req, res) {
  try {
    const { recipient, message_body, type, user_timezone } = req.body;

    if (!type || !['individual', 'group', 'status'].includes(type)) {
      return res.status(400).json({ message: 'Invalid type. Must be individual, group, or status.' });
    }
    if (type !== 'status' && !recipient) {
      return res.status(400).json({ message: 'recipient is required for individual/group messages' });
    }
    if (!message_body && !req.file) {
      return res.status(400).json({ message: 'Please provide a message or attach media' });
    }

    const userId = req.user.id;
    if (getStatus(userId) !== 'connected') {
      return res.status(400).json({ message: 'WhatsApp is not connected' });
    }

    const tz     = user_timezone || req.user.timezone || process.env.DEFAULT_TIMEZONE;
    const nowUtc = moment().utc().format('YYYY-MM-DD HH:mm:ss');

    let mediaPath = null, mediaType = null, mediaFilename = null;
    if (req.file) {
      mediaPath     = req.file.filename;
      mediaType     = getMediaType(req.file.mimetype);
      mediaFilename = req.file.originalname;
    }

    const [result] = await pool.execute(
      `INSERT INTO scheduled_messages
       (user_id, recipient, message_body, media_path, media_type, media_filename, type, scheduled_at, user_timezone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, recipient || null, message_body || null, mediaPath, mediaType, mediaFilename, type, nowUtc, tz]
    );

    const msgId    = result.insertId;
    const waClient = getClient(userId);

    try {
      const waResult    = await sendMessage(waClient, { id: msgId, type, recipient: recipient || null, message_body: message_body || null, media_path: mediaPath, media_type: mediaType });
      const waMessageId = waResult?.id?._serialized || waResult?.id?.id || null;

      let totalRecipients = 0;
      if (type === 'group' && recipient) {
        try {
          const chat = await waClient.getChatById(recipient);
          totalRecipients = Math.max(0, (chat?.participants?.length || 0) - 1);
        } catch { /* ignore */ }
      }

      await pool.execute(
        `UPDATE scheduled_messages SET status = 'sent', sent_at = UTC_TIMESTAMP(), wa_message_id = ?, ack_status = 1, total_recipients = ? WHERE id = ?`,
        [waMessageId, totalRecipients, msgId]
      );
      res.status(200).json({ message: 'Message sent successfully', id: msgId });
    } catch (sendErr) {
      const errMsg = String(sendErr?.message || sendErr || 'Unknown error').substring(0, 500);
      await pool.execute(`UPDATE scheduled_messages SET status = 'failed', error_message = ? WHERE id = ?`, [errMsg, msgId]);
      res.status(500).json({ message: `Failed to send: ${errMsg}` });
    }
  } catch (err) {
    console.error('[sendNow]', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function triggerNow(req, res) {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin only' });
    }
    await processMessages();
    res.json({ message: 'Scheduler triggered manually' });
  } catch (err) {
    console.error('[triggerNow]', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

module.exports = { listMessages, createMessage, sendNow, updateMessage, deleteMessage, triggerNow };