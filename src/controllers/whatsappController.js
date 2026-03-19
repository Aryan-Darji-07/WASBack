const waService = require('../services/whatsappService');
const pool = require('../config/db');

/**
 * All endpoints below are user-scoped.
 * Each user manages their own WhatsApp connection independently.
 * Admins can also inspect/control any user's connection.
 */

// Helper: resolve which userId to act on
function resolveUserId(req) {
  if (req.user.role === 'admin' && req.query.userId) {
    return parseInt(req.query.userId);
  }
  return req.user.id;
}

async function getStatus(req, res) {
  try {
    const userId = resolveUserId(req);

    // If no active client but session exists in DB, start reconnecting immediately
    if (waService.getStatus(userId) === 'disconnected') {
      waService.autoReconnectIfSession(userId).catch(() => {});
    }

    res.json({
      status: waService.getStatus(userId),
      qr: waService.getQR(userId),
      userId,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

// Admin-only: get WA status for every user that has an active client
async function getAllStatuses(req, res) {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin only' });
    }
    res.json({ statuses: waService.getAllStatuses() });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function connect(req, res) {
  try {
    const userId = resolveUserId(req);
    const status = waService.getStatus(userId);

    if (status === 'connected') {
      return res.json({ message: 'Already connected', userId });
    }
    if (status === 'initializing' || status === 'qr_ready') {
      return res.json({ message: 'Initialization in progress', qr: waService.getQR(userId), userId });
    }

    // ─── NEW: Delete all old sessions for this user before creating a new one ─
    // This prevents stale/corrupt session data from causing auth failures and
    // ensures a clean QR scan produces a fresh session in DB.
    try {
      const [delResult] = await pool.execute(
        'DELETE FROM wa_sessions WHERE user_id = ?',
        [userId]
      );
      if (delResult.affectedRows > 0) {
        console.log(`[WA:${userId}] Cleared ${delResult.affectedRows} old session row(s) before new connect`);
      }
    } catch (delErr) {
      // Non-fatal — log and continue
      console.warn(`[WA:${userId}] Could not clear old sessions:`, delErr.message);
    }

    await waService.initializeClient(userId);
    res.json({ message: 'WhatsApp initialization started', userId });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function disconnect(req, res) {
  try {
    const userId = resolveUserId(req);
    await waService.disconnectClient(userId);
    res.json({ message: 'WhatsApp disconnected', userId });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function getGroups(req, res) {
  try {
    const userId = resolveUserId(req);
    // Return only groups that belong to this user
    const [groups] = await pool.execute(
      'SELECT * FROM wa_groups WHERE user_id = ? ORDER BY name ASC',
      [userId]
    );
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

async function syncGroups(req, res) {
  try {
    const userId = resolveUserId(req);
    const count = await waService.syncGroups(userId);
    const [groups] = await pool.execute(
      'SELECT * FROM wa_groups WHERE user_id = ? ORDER BY name ASC',
      [userId]
    );
    res.json({ message: `Synced ${count} group(s)`, groups });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/**
 * GET /api/whatsapp/contacts
 * Returns all contacts from the user's WA client with name + remote profile pic URL.
 * Profile images are fetched directly from WhatsApp servers (no local storage).
 *
 * Query params:
 *   ?sync=true  — force a fresh fetch from WA and update DB cache
 *   (default)   — return cached contacts from DB
 */
async function getContacts(req, res) {
  try {
    const userId = resolveUserId(req);
    const forceSync = req.query.sync === 'true';

    if (forceSync) {
      // Fetch live from WA client and update DB cache
      const count = await waService.syncContacts(userId);
      const [contacts] = await pool.execute(
        `SELECT phone, name, profile_pic_url, last_synced
         FROM wa_contacts WHERE user_id = ? ORDER BY name ASC`,
        [userId]
      );
      return res.json({ message: `Synced ${count} contact(s)`, contacts });
    }

    // Return cached contacts from DB
    const [contacts] = await pool.execute(
      `SELECT phone, name, profile_pic_url, last_synced
       FROM wa_contacts WHERE user_id = ? ORDER BY name ASC`,
      [userId]
    );
    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

/**
 * GET /api/whatsapp/groups/with-pics
 * Returns groups from DB — profile pics are stored as compressed base64 during syncGroups.
 */
async function getGroupsWithPics(req, res) {
  try {
    const userId = resolveUserId(req);
    const [groups] = await pool.execute(
      'SELECT * FROM wa_groups WHERE user_id = ? ORDER BY name ASC',
      [userId]
    );
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

/**
 * GET /api/whatsapp/groups/:jid/members
 * Returns all participants of a group with name resolution from wa_contacts.
 */
async function getGroupMembers(req, res) {
  try {
    const userId  = resolveUserId(req);
    const groupJid = decodeURIComponent(req.params.jid);

    const [members] = await pool.execute(
      `SELECT gm.phone,
              COALESCE(wc.name, NULL) AS name
       FROM wa_group_members gm
       LEFT JOIN wa_contacts wc ON wc.user_id = gm.user_id AND wc.phone = gm.phone
       WHERE gm.user_id = ? AND gm.group_jid = ?
       ORDER BY wc.name ASC, gm.phone ASC`,
      [userId, groupJid]
    );

    res.json({ members });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
}

module.exports = {
  getStatus,
  getAllStatuses,
  connect,
  disconnect,
  getGroups,
  syncGroups,
  getContacts,
  getGroupsWithPics,
  getGroupMembers,
};