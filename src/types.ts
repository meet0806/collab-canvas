export type Tool = 'pen' | 'eraser' | 'pan';

export type PointerPoint = {
  x: number;
  y: number;
  pressure: number;
};

export type StrokeObject = {
  id: string;
  type: 'stroke';
  color: string;
  width: number;
  points: PointerPoint[];
  createdBy: string;
  createdAt: number;
};

export type CanvasObject = StrokeObject;

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type UserProfile = {
  id: string;
  name: string;
  color: string;
};

export type CursorVariant = 'arrow' | 'diamond' | 'circle' | 'square';

export type CursorState = {
  x: number;
  y: number;
  tool: Tool;
};

export type AwarenessUser = {
  user?: UserProfile;
  cursor?: CursorState | null;
  draft?: StrokeObject | null;
};

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type RoomUser = {
  clientId: number;
  profile: UserProfile;
  cursor: CursorState | null;
  draft: StrokeObject | null;
  displayName: string;
  color: string;
  participantNumber: number;
  cursorVariant: CursorVariant;
  isLocal: boolean;
};
