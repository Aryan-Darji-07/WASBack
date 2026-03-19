require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  // Suppress known benign ENOENT from whatsapp-web.js RemoteAuth.deleteMetadata.
  // This fires when the temp session directory is cleaned up before compressSession
  // finishes — the session is already safely saved to disk, so this is harmless.
  const msg = reason?.message || String(reason);
  if (msg.includes('ENOENT') && msg.includes('wwebjs_temp_session')) return;
  console.error('[Process] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.message || err);
});

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const path   = require('path');

const waService = require('./services/whatsappService');
const { startScheduler } = require('./services/schedulerService');

const authRoutes      = require('./routes/auth');
const userRoutes      = require('./routes/users');
const whatsappRoutes  = require('./routes/whatsapp');
const messageRoutes   = require('./routes/messages');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin:  process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

waService.setIO(io);

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/auth',      authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/whatsapp',  whatsappRoutes);
app.use('/api/messages',  messageRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// if (process.env.NODE_ENV === 'production') {
//   const frontendBuild = path.join(__dirname, '../../frontend/dist');
//   app.use(express.static(frontendBuild));
//   app.get('*', (req, res) => {
//     res.sendFile(path.join(frontendBuild, 'index.html'));
//   });
// }

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File size exceeds 16MB limit' });
  }
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  socket.on('join', async ({ userId }) => {
    if (!userId) return;
    const room = `user:${userId}`;
    socket.join(room);
    console.log(`[Socket] ${socket.id} joined room ${room}`);

    // If no active client but a session exists in DB, start reconnecting.
    // (On startup reconnectAllSessionsOnStartup already handles this, but
    // if a user opens the browser before their reconnect fires, this covers it.)
    await waService.autoReconnectIfSession(userId);

    socket.emit('wa:status', {
      status: waService.getStatus(userId),
      qr:     waService.getQR(userId),
      userId,
    });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

const PORT = parseInt(process.env.PORT) || 5000;

server.listen(PORT, async () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);

  startScheduler();

  // ── FIX #3: Reconnect every user that has a stored WA session on startup ──
  // Staggered by 3 s per user so Puppeteer isn't overwhelmed.
  await waService.reconnectAllSessionsOnStartup();
});

module.exports = { app, server, io };