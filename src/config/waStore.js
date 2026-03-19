const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ─── Session zip files stored here instead of in the DB as blobs ─────────────
// Resolves to  <project-root>/uploads/sessions/
const SESSIONS_DIR = path.resolve(__dirname, '../../uploads/sessions');

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(`[WAStore] Created sessions directory: ${SESSIONS_DIR}`);
  }
}

/**
 * Custom MySQL store for whatsapp-web.js RemoteAuth.
 *
 * CHANGED FROM ORIGINAL:
 *   - Session zip is written to  uploads/sessions/<uuid>.gz
 *   - Only the file path (relative: sessions/<uuid>.gz) is stored in DB
 *   - This avoids 10–50 MB MEDIUMTEXT blobs and makes DB writes instant
 *   - On each new connect the OLD file is deleted after the new one is written
 *
 * Required table (simplified — no chunk_index needed any more):
 *
 *   DROP TABLE IF EXISTS wa_sessions;
 *   CREATE TABLE wa_sessions (
 *     id           INT AUTO_INCREMENT PRIMARY KEY,
 *     user_id      INT NOT NULL,
 *     session_id   VARCHAR(255) NOT NULL,
 *     session_file VARCHAR(500) NOT NULL   COMMENT 'Relative path under uploads/',
 *     updated_at   DATETIME DEFAULT NOW() ON UPDATE NOW(),
 *     UNIQUE KEY uq_user_session (user_id, session_id),
 *     CONSTRAINT fk_wa_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
 *   );
 *
 * If you are migrating from the old chunked schema run:
 *   ALTER TABLE wa_sessions
 *     DROP KEY IF EXISTS uq_session_chunk,
 *     DROP KEY IF EXISTS uq_user_session_chunk,
 *     DROP COLUMN IF EXISTS chunk_index,
 *     DROP COLUMN IF EXISTS session_data,
 *     ADD COLUMN IF NOT EXISTS session_file VARCHAR(500) NOT NULL DEFAULT '' AFTER session_id,
 *     ADD UNIQUE KEY uq_user_session (user_id, session_id);
 */
class MySQLStore {
  /**
   * @param {import('mysql2/promise').Pool} pool
   * @param {number} userId – the user this store instance belongs to
   */
  constructor(pool, userId) {
    this.pool   = pool;
    this.userId = userId;
    ensureSessionsDir();
  }

  // ─── Check if a session row exists ────────────────────────────────────────
  async sessionExists({ session }) {
    const [rows] = await this.pool.execute(
      'SELECT id FROM wa_sessions WHERE user_id = ? AND session_id = ? LIMIT 1',
      [this.userId, session]
    );
    return rows.length > 0;
  }

  // ─── Save: zip → gzip → disk file, store path in DB ──────────────────────
  async save({ session }) {
    const zipPath  = `${session}.zip`;
    const sessionId = path.basename(session);

    try {
      if (!fs.existsSync(zipPath)) {
        console.warn(`[WAStore:${this.userId}] Zip not found at ${zipPath}`);
        return;
      }

      const rawBuffer  = fs.readFileSync(zipPath);
      const compressed = await gzip(rawBuffer);

      // Generate a unique filename so concurrent users never clash
      const uniqueName = `${this.userId}_${crypto.randomUUID()}.gz`;
      const destPath   = path.join(SESSIONS_DIR, uniqueName);
      const relPath    = `sessions/${uniqueName}`; // stored in DB

      fs.writeFileSync(destPath, compressed);

      // console.log(
      //   `[WAStore:${this.userId}] Session written: ` +
      //   `${(rawBuffer.length / 1024 / 1024).toFixed(1)} MB raw → ` +
      //   `${(compressed.length / 1024 / 1024).toFixed(1)} MB gzip → ${destPath}`
      // );

      // ── Fetch old file path before overwriting so we can delete it ────────
      let oldFile = null;
      try {
        const [oldRows] = await this.pool.execute(
          'SELECT session_file FROM wa_sessions WHERE user_id = ? AND session_id = ? LIMIT 1',
          [this.userId, sessionId]
        );
        if (oldRows.length > 0) oldFile = oldRows[0].session_file;
      } catch { /* non-fatal */ }

      // ── Upsert the new file path ───────────────────────────────────────────
      await this.pool.execute(
        `INSERT INTO wa_sessions (user_id, session_id, session_file)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE session_file = VALUES(session_file), updated_at = NOW()`,
        [this.userId, sessionId, relPath]
      );

      // console.log(`[WAStore:${this.userId}] Session "${sessionId}" saved → ${relPath}`);

      // ── Delete the OLD file AFTER the DB row is safely updated ────────────
      if (oldFile && oldFile !== relPath) {
        const oldAbsPath = path.resolve(__dirname, '../../uploads', oldFile);
        try {
          if (fs.existsSync(oldAbsPath)) {
            fs.unlinkSync(oldAbsPath);
            // console.log(`[WAStore:${this.userId}] Deleted old session file: ${oldAbsPath}`);
          }
        } catch (delErr) {
          console.warn(`[WAStore:${this.userId}] Could not delete old file ${oldAbsPath}:`, delErr.message);
        }
      }
    } catch (err) {
      console.error(`[WAStore:${this.userId}] Failed to save session "${sessionId}":`, err.message);
      throw err;
    }
  }

  // ─── Extract: read gzip from disk, write zip back for Puppeteer ──────────
  async extract({ session, path: extractPath }) {
    const sessionId = path.basename(session);

    const [rows] = await this.pool.execute(
      'SELECT session_file FROM wa_sessions WHERE user_id = ? AND session_id = ? LIMIT 1',
      [this.userId, sessionId]
    );

    if (rows.length === 0) {
      console.warn(`[WAStore:${this.userId}] No session record found for "${sessionId}"`);
      return;
    }

    const relPath = rows[0].session_file;
    const absPath = path.resolve(__dirname, '../../uploads', relPath);

    if (!fs.existsSync(absPath)) {
      console.warn(`[WAStore:${this.userId}] Session file missing on disk: ${absPath}. Will need fresh QR.`);
      // Clean up stale DB row so autoReconnect doesn't loop trying to restore
      await this.pool.execute(
        'DELETE FROM wa_sessions WHERE user_id = ? AND session_id = ?',
        [this.userId, sessionId]
      ).catch(() => {});
      return;
    }

    const compressed = fs.readFileSync(absPath);

    let data;
    try {
      data = await gunzip(compressed);
    } catch {
      data = compressed; // fallback: already uncompressed legacy file
    }

    fs.writeFileSync(extractPath, data);
    console.log(`[WAStore:${this.userId}] Session "${sessionId}" extracted from ${absPath}`);
  }

  // ─── Delete: remove DB row AND disk file ─────────────────────────────────
  async delete({ session }) {
    const sessionId = path.basename(session);

    try {
      const [rows] = await this.pool.execute(
        'SELECT session_file FROM wa_sessions WHERE user_id = ? AND session_id = ? LIMIT 1',
        [this.userId, sessionId]
      );

      if (rows.length > 0) {
        const absPath = path.resolve(__dirname, '../../uploads', rows[0].session_file);
        try {
          if (fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
            // console.log(`[WAStore:${this.userId}] Deleted session file: ${absPath}`);
          }
        } catch (delErr) {
          console.warn(`[WAStore:${this.userId}] Could not delete file:`, delErr.message);
        }
      }
    } catch { /* non-fatal */ }

    await this.pool.execute(
      'DELETE FROM wa_sessions WHERE user_id = ? AND session_id = ?',
      [this.userId, sessionId]
    );
    // console.log(`[WAStore:${this.userId}] Session "${sessionId}" deleted`);
  }
}

module.exports = MySQLStore;