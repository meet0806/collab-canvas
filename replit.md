# Real-Time Collaborative Canvas

A production-oriented multiplayer whiteboard built with React, TypeScript, Rust/WebAssembly, Yjs CRDTs, and WebSockets.

## Stack

- **Frontend**: React 18 + TypeScript, Vite, Yjs (CRDT sync), lucide-react
- **Backend**: Node.js (ESM), `ws` WebSocket server, `pg` (PostgreSQL)
- **Rendering**: Rust/WASM (pressure-aware stroke rasterisation) in a dedicated Web Worker
- **Collaboration**: `y-websocket` for Yjs document sync; custom presence channel for live cursors

## Running locally on Replit

The first run requires compiling the Rust renderer to WASM (~2–3 min):

```bash
npm install
npm run build:wasm   # cargo build → wasm32-unknown-unknown, copies to public/wasm/
npm run dev          # starts Node server (port 1234) + Vite dev server (port 5173)
```

Open the Replit preview (port 5173). Vite proxies `/api`, `/sync`, and `/presence` to the Node server.

## Architecture

- `src/` — React app: input, tool state, Yjs orchestration
- `server/index.mjs` — Node HTTP + WebSocket server (rooms, sessions, Yjs sync, presence)
- `crates/canvas-wasm/` — Rust renderer compiled to WASM
- `src/render/canvas.worker.ts` — Web Worker that loads the WASM and renders the retained scene

## Persistence

Rooms and sessions are stored in Replit's built-in PostgreSQL (`DATABASE_URL`). The schema is created automatically on server start (`initSchema()`). Presence (live cursor positions, in-progress strokes) stays in-memory — it is ephemeral and tied to live WebSocket connections.

Sessions expire after 24 hours of inactivity.

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/rooms` | Create a room; returns room + anonymous editor session |
| GET | `/api/rooms/:code` | Public room metadata |
| POST | `/api/rooms/:code/join` | Join a room; returns session token + WebSocket endpoints |
| GET | `/healthz` | Health check with live room/session counts |

WebSocket endpoints (authenticated via `?token=`):
- `/sync/:code` — Yjs document sync (`y-websocket` protocol)
- `/presence/:code` — Ephemeral cursor/draft broadcast

## User preferences

_None recorded yet._
