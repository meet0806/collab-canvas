import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';
import { randomBytes, randomUUID } from 'node:crypto';
import ws from 'ws';

const require = createRequire(import.meta.url);
const { setupWSConnection } = require('y-websocket/bin/utils');
const { Server: WebSocketServer } = ws;

const host = process.env.HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.PORT ?? '1234', 10);
const rootDir = resolve(new URL('..', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0));
const distDir = resolve(rootDir, 'dist');

const participantColors = ['#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2', '#be123c'];
const cursorVariants = ['arrow', 'diamond', 'circle', 'square'];

const roomsByCode = new Map();
const roomsById = new Map();
const sessionsByToken = new Map();
const presenceRooms = new Map();
const presenceSockets = new Map();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        service: 'collab-canvas',
        rooms: roomsById.size,
        sessions: sessionsByToken.size
      });
      return;
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await readJson(request);
      const room = createRoom(body?.title);
      const session = createSession(room);
      sendJson(response, 201, toJoinResponse(request, room, session));
      return;
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (roomMatch && request.method === 'GET') {
      const room = roomsByCode.get(normalizeCode(roomMatch[1]));
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
      const room = roomsByCode.get(code);
      if (!room) {
        sendJson(response, 404, { error: 'room_not_found' });
        return;
      }

      const session = createSession(room);
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

const syncWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  clientTracking: true
});
const presenceWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  clientTracking: true
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/sync/')) {
    const session = authenticateUpgrade(url);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    request.collabSession = session;
    syncWss.handleUpgrade(request, socket, head, (ws) => {
      syncWss.emit('connection', ws, request);
    });
    return;
  }

  if (url.pathname.startsWith('/presence/')) {
    const session = authenticateUpgrade(url);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    request.collabSession = session;
    presenceWss.handleUpgrade(request, socket, head, (ws) => {
      presenceWss.emit('connection', ws, request);
    });
    return;
  }

  socket.destroy();
});

syncWss.on('connection', (socket, request) => {
  const session = request.collabSession;
  setupWSConnection(socket, request, {
    docName: session.roomId,
    gc: true
  });
});

presenceWss.on('connection', (socket, request) => {
  const session = request.collabSession;
  let room = presenceRooms.get(session.roomId);

  if (!room) {
    room = new Map();
    presenceRooms.set(session.roomId, room);
  }

  room.set(session.sessionToken, {
    session,
    cursor: null,
    draft: null,
    updatedAt: Date.now()
  });
  presenceSockets.set(socket, session);

  broadcastPresence(session.roomId);

  socket.on('message', (payload) => {
    try {
      const message = JSON.parse(payload.toString());
      const state = room.get(session.sessionToken);

      if (!state || message.type !== 'presence-update') {
        return;
      }

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

const interval = setInterval(() => {
  expireSessions();

  for (const client of syncWss.clients) {
    if (client.readyState === client.OPEN) {
      client.ping();
    }
  }

  for (const client of presenceWss.clients) {
    if (client.readyState === client.OPEN) {
      client.ping();
    }
  }
}, 30_000);

server.listen(port, host, () => {
  console.log(`collab server listening on http://${host}:${port}`);
});

const shutdown = () => {
  clearInterval(interval);
  syncWss.close(() => {
    presenceWss.close(() => {
      server.close(() => process.exit(0));
    });
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function createRoom(title) {
  const inviteCode = makeRoomCode();
  const now = new Date().toISOString();
  const room = {
    id: randomUUID(),
    inviteCode,
    title: typeof title === 'string' && title.trim() ? title.trim() : 'Untitled canvas',
    createdAt: now,
    updatedAt: now,
    nextParticipantNumber: 1,
    sessions: new Map()
  };

  roomsByCode.set(inviteCode, room);
  roomsById.set(room.id, room);
  return room;
}

function createSession(room) {
  const participantNumber = room.nextParticipantNumber++;
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
    lastSeenAt: Date.now()
  };

  room.sessions.set(session.sessionToken, session);
  sessionsByToken.set(session.sessionToken, session);
  return session;
}

function authenticateUpgrade(url) {
  const token = url.searchParams.get('token');
  const code = normalizeCode(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
  const session = token ? sessionsByToken.get(token) : null;

  if (!session || session.inviteCode !== code) {
    return null;
  }

  session.lastSeenAt = Date.now();
  return session;
}

function broadcastPresence(roomId) {
  const room = presenceRooms.get(roomId);
  if (!room) {
    return;
  }

  const users = [...room.values()].map((state) => ({
    clientId: state.session.participantNumber,
    profile: {
      id: state.session.userId,
      name: state.session.displayName,
      color: state.session.color
    },
    cursor: state.cursor,
    draft: state.draft,
    displayName: state.session.displayName,
    color: state.session.color,
    participantNumber: state.session.participantNumber,
    cursorVariant: state.session.cursorVariant,
    updatedAt: state.updatedAt
  }));
  const payload = JSON.stringify({ type: 'presence-state', users });

  for (const client of presenceWss.clients) {
    if (client.readyState === client.OPEN && presenceSockets.get(client)?.roomId === roomId) {
      client.send(payload);
    }
  }
}

function expireSessions() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  for (const [token, session] of sessionsByToken.entries()) {
    if (session.lastSeenAt > cutoff) {
      continue;
    }

    sessionsByToken.delete(token);
    roomsById.get(session.roomId)?.sessions.delete(token);
  }
}

function toJoinResponse(request, room, session) {
  const publicRoom = toPublicRoom(request, room);
  return {
    room: publicRoom,
    session: {
      token: session.sessionToken,
      roomId: room.id,
      inviteCode: room.inviteCode,
      userId: session.userId,
      displayName: session.displayName,
      color: session.color,
      cursorVariant: session.cursorVariant,
      participantNumber: session.participantNumber,
      role: session.role
    },
    endpoints: {
      sync: `${wsOrigin(request)}/sync/${room.inviteCode}?token=${session.sessionToken}`,
      presence: `${wsOrigin(request)}/presence/${room.inviteCode}?token=${session.sessionToken}`
    }
  };
}

function toPublicRoom(request, room) {
  return {
    id: room.id,
    inviteCode: room.inviteCode,
    title: room.title,
    inviteUrl: `${httpOrigin(request)}/?room=${room.inviteCode}`,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function serveStatic(url, response) {
  if (!existsSync(distDir)) {
    return false;
  }

  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const candidate = cleanPath ? resolve(distDir, cleanPath) : resolve(distDir, 'index.html');
  const filePath = candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : resolve(distDir, 'index.html');

  if (!existsSync(filePath)) {
    return false;
  }

  response.writeHead(200, {
    'content-type': mimeType(filePath),
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
  });
  createReadStream(filePath).pipe(response);
  return true;
}

function mimeType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
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
