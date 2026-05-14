const COLORS = ['#0f766e', '#be123c', '#6d28d9', '#b45309', '#2563eb', '#15803d', '#c2410c'];

export function makeClientId(): string {
  return crypto.randomUUID();
}

export function makeClientName(id: string): string {
  return `User ${id.slice(0, 4).toUpperCase()}`;
}

export function colorForClient(id: string): string {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return COLORS[hash % COLORS.length];
}

export function makeObjectId(clientId: string): string {
  return `${clientId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

export function normalizeRoomCode(code: string): string {
  const value = code.trim();

  try {
    const url = new URL(value, window.location.origin);
    const room = url.searchParams.get('room');
    if (room) {
      return normalizeRoomCode(room);
    }
  } catch {
    // Fall through to raw code normalization.
  }

  return value.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
}
