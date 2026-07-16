import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import process from 'node:process';
import { randomBytes, randomUUID } from 'node:crypto';
import ws from 'ws';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const require = createRequire(import.meta.url);
const { setupWSConnection } = require('y-websocket/bin/utils');
const { Server: WebSocketServer } = ws;

const host = process.env.HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.PORT ?? '1234', 10);
const rootDir = resolve(new URL('..', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0));
const distDir = resolve(rootDir, 'dist');

const participantColors = ['#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2', '#be123c'];
const cursorVariants = ['arrow', 'diamond', 'circle', 'square'];

// Ephemeral presence state – stays in-memory (tracks live WebSocket connections only).
const presenceRooms = new Map();
const presenceSockets = new Map();

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id UUID PRIMARY KEY,
      invite_code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      next_participant_number INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_token UUID PRIMARY KEY,
      room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      invite_code TEXT NOT NULL,
      user_id UUID NOT NULL,
      display_name TEXT NOT NULL,
      color TEXT NOT NULL,
      cursor_variant TEXT NOT NULL,
      participant_number INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      created_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_room_id_idx ON sessions(room_id);
    CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions(last_seen_at);
  `);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Map a DB row to the room shape used throughout the server. */
function rowToRoom(row) {
  return {
    id: row.id,
    inviteCode: row.invite_code,
    title: row.title,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

/** Map a DB row to the session shape used throughout the server. */
function rowToSession(row) {
  return {
    sessionToken: row.session_token,
    roomId: row.room_id,
    inviteCode: row.invite_code,
    userId: row.user_id,
    displayName: row.display_name,
    color: row.color,
    cursorVariant: row.cursor_variant,
    participantNumber: Number(row.participant_number),
    role: row.role,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

async function createRoom(title) {
  const inviteCode = makeRoomCode();
  const now = new Date();
  const id = randomUUID();
  const normalizedTitle = typeof title === 'string' && title.trim() ? title.trim() : 'Untitled canvas';

  await pool.query(
    `INSERT INTO rooms (id, invite_code, title, created_at, updated_at, next_participant_number)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [id, inviteCode, normalizedTitle, now, now],
  );

  return rowToRoom({ id, invite_code: inviteCode, title: normalizedTitle, created_at: now, updated_at: now });
}

async function getRoomByCode(code) {
  const { rows } = await pool.query(
    'SELECT id, invite_code, title, created_at, updated_at FROM rooms WHERE invite_code = $1',
    [code],
  );
  return rows[0] ? rowToRoom(rows[0]) : null;
}

async function createSession(room) {
  // Atomically claim the next participant slot and get the number we were assigned.
  const { rows } = await pool.query(
    `UPDATE rooms
     SET next_participant_number = next_participant_number + 1,
         updated_at = NOW()
     WHERE id = $1
     RETURNING next_participant_number - 1 AS participant_number`,
    [room.id],
  );
  const participantNumber = Number(rows[0].participant_number);

  const session = {
    sessionToken: randomUUID(),
    roomId: room.id,
    inviteCode: room.inviteCode,
    userId: randomUUID(),
    displayName: `User ${participantNumber}`,
    color: participantColors[(participantNumber - 1) % participantColors.length],
    cursorVariant: cursorVariants[(participantNumber - 1) % cursorVariants.length],
    participantNumber,
    role: 'editor',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };

  await pool.query(
    `INSERT INTO sessions
       (session_token, room_id, invite_code, user_id, display_name, color,
        cursor_variant, participant_number, role, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      session.sessionToken,
      session.roomId,
      session.inviteCode,
      session.userId,
      session.displayName,
      session.color,
      session.cursorVariant,
      session.participantNumber,
      session.role,
      session.createdAt,
      session.lastSeenAt,
    ],
  );

  return session;
}

async function getSessionByToken(token) {
  const { rows } = await pool.query(
    'SELECT * FROM sessions WHERE session_token = $1',
    [token],
  );
  return rows[0] ? rowToSession(rows[0]) : null;
}

async function touchSession(token) {
  await pool.query(
    'UPDATE sessions SET last_seen_at = $1 WHERE session_token = $2',
    [Date.now(), token],
  );
}

async function expireSessions() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await pool.query('DELETE FROM sessions WHERE last_seen_at < $1', [cutoff]);
}

async function countStats() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM rooms) AS rooms,
       (SELECT count(*)::int FROM sessions) AS sessions`,
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      const { rooms, sessions } = await countStats();
      sendJson(response, 200, { ok: true, service: 'collab-canvas', rooms, sessions });
      return;
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await readJson(request);
      const room = await createRoom(body?.title);
      const session = await createSession(room);
      sendJson(response, 201, toJoinResponse(request, room, session));
      return;
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (roomMatch && request.method === 'GET') {
      const room = await getRoomByCode(normalizeCode(roomMatch[1]));
      if (!room) {
        sendJson(response, 404, { error: 'room_not_found' });
        return;
      }
      sendJson(response, 200, toPublicRoom(request, room));
      return;
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (joinMatch && request.method === 'POST') {
      const code = normalizeCode(joinMatch[1]);
      const room = await getRoomByCode(code);
      if (!room) {
        sendJson(response, 404, { error: 'room_not_found' });
        return;
      }
      const session = await createSession(room);
      sendJson(response, 200, toJoinResponse(request, room, session));
      return;
    }

    if (serveStatic(url, response)) {
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------------
// WebSocket servers
// ---------------------------------------------------------------------------

const syncWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: true });
const presenceWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: true });

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/sync/')) {
    const session = await authenticateUpgrade(url);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    request.collabSession = session;
    syncWss.handleUpgrade(request, socket, head, (ws) => syncWss.emit('connection', ws, request));
    return;
  }

  if (url.pathname.startsWith('/presence/')) {
    const session = await authenticateUpgrade(url);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    request.collabSession = session;
    presenceWss.handleUpgrade(request, socket, head, (ws) => presenceWss.emit('connection', ws, request));
    return;
  }

  socket.destroy();
});

syncWss.on('connection', (socket, request) => {
  const session = request.collabSession;
  setupWSConnection(socket, request, { docName: session.roomId, gc: true });
});

presenceWss.on('connection', (socket, request) => {
  const session = request.collabSession;
  let room = presenceRooms.get(session.roomId);
  if (!room) {
    room = new Map();
    presenceRooms.set(session.roomId, room);
  }

  room.set(session.sessionToken, { session, cursor: null, draft: null, updatedAt: Date.now() });
  presenceSockets.set(socket, session);
  broadcastPresence(session.roomId);

  socket.on('message', (payload) => {
    try {
      const message = JSON.parse(payload.toString());
      const state = room.get(session.sessionToken);
      if (!state || message.type !== 'presence-update') return;
      state.cursor = message.cursor ?? null;
      state.draft = message.draft ?? null;
      state.updatedAt = Date.now();
      broadcastPresence(session.roomId);
    } catch {
      socket.close(1003, 'invalid presence message');
    }
  });

  socket.on('close', () => {
    room.delete(session.sessionToken);
    presenceSockets.delete(socket);
    if (room.size === 0) {
      presenceRooms.delete(session.roomId);
      return;
    }
    broadcastPresence(session.roomId);
  });
});

// ---------------------------------------------------------------------------
// Maintenance interval
// ---------------------------------------------------------------------------

const interval = setInterval(async () => {
  await expireSessions().catch((err) => console.error('expireSessions error:', err));

  for (const client of syncWss.clients) {
    if (client.readyState === client.OPEN) client.ping();
  }
  for (const client of presenceWss.clients) {
    if (client.readyState === client.OPEN) client.ping();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

initSchema()
  .then(() => {
    server.listen(port, host, () => {
      console.log(`collab server listening on http://${host}:${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database schema:', err);
    process.exit(1);
  });

const shutdown = () => {
  clearInterval(interval);
  syncWss.close(() => {
    presenceWss.close(() => {
      pool.end(() => {
        server.close(() => process.exit(0));
      });
    });
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

async function authenticateUpgrade(url) {
  const token = url.searchParams.get('token');
  const code = normalizeCode(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
  if (!token) return null;

  const session = await getSessionByToken(token);
  if (!session || session.inviteCode !== code) return null;

  await touchSession(token);
  return session;
}

function broadcastPresence(roomId) {
  const room = presenceRooms.get(roomId);
  if (!room) return;

  const users = [...room.values()].map((state) => ({
    clientId: state.session.participantNumber,
    profile: { id: state.session.userId, name: state.session.displayName, color: state.session.color },
    cursor: state.cursor,
    draft: state.draft,
    displayName: state.session.displayName,
    color: state.session.color,
    participantNumber: state.session.participantNumber,
    cursorVariant: state.session.cursorVariant,
    updatedAt: state.updatedAt,
  }));
  const payload = JSON.stringify({ type: 'presence-state', users });

  for (const client of presenceWss.clients) {
    if (client.readyState === client.OPEN && presenceSockets.get(client)?.roomId === roomId) {
      client.send(payload);
    }
  }
}

function toJoinResponse(request, room, session) {
  return {
    room: toPublicRoom(request, room),
    session: {
      token: session.sessionToken,
      roomId: room.id,
      inviteCode: room.inviteCode,
      userId: session.userId,
      displayName: session.displayName,
      color: session.color,
      cursorVariant: session.cursorVariant,
      participantNumber: session.participantNumber,
      role: session.role,
    },
    endpoints: {
      sync: `${wsOrigin(request)}/sync/${room.inviteCode}?token=${session.sessionToken}`,
      presence: `${wsOrigin(request)}/presence/${room.inviteCode}?token=${session.sessionToken}`,
    },
  };
}

function toPublicRoom(request, room) {
  return {
    id: room.id,
    inviteCode: room.inviteCode,
    title: room.title,
    inviteUrl: `${httpOrigin(request)}/?room=${room.inviteCode}`,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function serveStatic(url, response) {
  if (!existsSync(distDir)) return false;

  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const candidate = cleanPath ? resolve(distDir, cleanPath) : resolve(distDir, 'index.html');
  const filePath =
    candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : resolve(distDir, 'index.html');

  if (!existsSync(filePath)) return false;

  response.writeHead(200, {
    'content-type': mimeType(filePath),
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(filePath).pipe(response);
  return true;
}

function mimeType(filePath) {
  switch (extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':   return 'text/javascript; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.svg':  return 'image/svg+xml';
    default:      return 'application/octet-stream';
  }
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('').toLowerCase();
}

function normalizeCode(code) {
  return String(code).trim().replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
}

function httpOrigin(request) {
  const proto = request.headers['x-forwarded-proto'] ?? 'http';
  return `${proto}://${request.headers.host ?? `localhost:${port}`}`;
}

function wsOrigin(request) {
  const proto = request.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  return `${proto}://${request.headers.host ?? `localhost:${port}`}`;
}
