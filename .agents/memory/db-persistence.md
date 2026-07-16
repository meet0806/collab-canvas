---
name: DB persistence for rooms/sessions
description: How rooms and sessions are persisted to PostgreSQL; what stays in-memory and why; npm install gotcha.
---

# DB persistence for rooms and sessions

## The rule
Rooms and sessions live in PostgreSQL (`rooms` + `sessions` tables). Presence state (`presenceRooms`, `presenceSockets` Maps) stays in-memory — it tracks live WebSocket connections and is intentionally ephemeral.

**Why:** The original README called this out explicitly. Yjs document state is handled by `y-websocket`'s own in-memory store (not persisted — a separate concern if needed later).

## How to apply
- Schema is bootstrapped by `initSchema()` called before `server.listen()`. Safe to call on every start (`CREATE TABLE IF NOT EXISTS`).
- Participant numbers are assigned atomically: `UPDATE rooms SET next_participant_number = next_participant_number + 1 RETURNING next_participant_number - 1 AS participant_number`.
- `DATABASE_URL` env var is used by the `pg` Pool — already available in Replit's environment.

## npm install gotcha
`concurrently@9.1.2` depends on `shell-quote@1.8.3`, which is blocked by Replit's Package Firewall (vulnerability). Fix: add `"overrides": { "shell-quote": "^1.8.4" }` to `package.json` before running `npm install`.
