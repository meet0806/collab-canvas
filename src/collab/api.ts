import { normalizeRoomCode } from './id';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export type RoomInfo = {
  id: string;
  inviteCode: string;
  title: string;
  inviteUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type RoomSession = {
  token: string;
  roomId: string;
  inviteCode: string;
  userId: string;
  displayName: string;
  color: string;
  cursorVariant: 'arrow' | 'diamond' | 'circle' | 'square';
  participantNumber: number;
  role: 'editor' | 'viewer';
};

export type JoinRoomResponse = {
  room: RoomInfo;
  session: RoomSession;
  endpoints: {
    sync: string;
    presence: string;
  };
};

export async function createRoom(): Promise<JoinRoomResponse> {
  return request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function joinRoom(codeOrLink: string): Promise<JoinRoomResponse> {
  const code = normalizeRoomCode(codeOrLink);
  return request(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers
    }
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? 'request_failed');
  }

  return payload as T;
}
