# Real-Time Collaborative Canvas

A production-oriented multiplayer whiteboard built with React, TypeScript, Rust/WebAssembly, Yjs CRDTs, and WebSockets.

## What is included

- Conflict-free shared canvas state with Yjs.
- WebSocket sync service compatible with `y-websocket`.
- Live multi-user cursor presence through Yjs awareness.
- Per-user undo/redo through `Y.UndoManager`.
- Rendering isolated in a dedicated Web Worker.
- Rust/WASM rasterization for stroke rendering and bounding-box calculation.
- Pointer-pressure aware pen input with pan/zoom, color, width, erase, undo, redo, and clear.

## Requirements

- Node.js 20+
- Rust 1.89+
- `wasm32-unknown-unknown` target:

```bash
rustup target add wasm32-unknown-unknown
```

## Run locally

```bash
npm install
npm run build:wasm
npm run dev
```

Open two browser windows at the Vite URL and use the same room name to verify live sync.

## Run with Docker

```bash
docker compose up --build
```

Open `http://localhost:1234`. The container serves the API, WebSocket sync endpoints, presence channel, and production frontend from the same port.

## Room API

- `POST /api/rooms`: creates a room and returns an anonymous editor session.
- `GET /api/rooms/:code`: reads public room metadata.
- `POST /api/rooms/:code/join`: joins a room and returns a session token plus WebSocket endpoints.

Room/session state is in memory in this implementation. It is structured so PostgreSQL/Redis can replace the in-memory maps without changing the frontend contract.

## Architecture

The React app owns input, tool state, and collaboration orchestration. Yjs is the only source of truth for committed canvas objects. Rooms and anonymous user sessions are created by the Node server. Ephemeral state such as active cursors and in-progress draft strokes is carried over the server-owned presence channel so it does not pollute undo history.

Rendering is moved off the main thread. The UI transfers an `OffscreenCanvas` to `src/render/canvas.worker.ts`, which loads `public/wasm/canvas_wasm.wasm`. The worker renders a retained scene and asks Rust/WASM to rasterize pressure-aware strokes into a pixel buffer before blitting to the canvas.

The server in `server/index.mjs` exposes a health endpoint and delegates WebSocket document synchronization to the Yjs WebSocket protocol.

## Scripts

- `npm run dev`: build WASM once, start sync server, and run Vite.
- `npm run build`: build WASM, typecheck, and produce a production bundle.
- `npm run dev:server`: run the collaboration server only.
- `npm run dev:web`: run the Vite app only.
- `npm run build:wasm`: compile the Rust renderer and copy it to `public/wasm`.
