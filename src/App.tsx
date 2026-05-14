import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CanvasStage } from './components/CanvasStage';
import { LandingPage } from './components/LandingPage';
import { PresenceBar } from './components/PresenceBar';
import { RoomControls } from './components/RoomControls';
import { Toolbar } from './components/Toolbar';
import { createRoom, joinRoom, JoinRoomResponse } from './collab/api';
import { makeObjectId, normalizeRoomCode } from './collab/id';
import { useCollaborativeCanvas } from './collab/useCollaborativeCanvas';
import { Camera, PointerPoint, StrokeObject, Tool } from './types';

const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function App() {
  const [room, setRoom] = useState<JoinRoomResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [initialRoomCode] = useState(() => getInitialRoomId());
  const attemptedInitialJoin = useRef(false);

  const openRoom = useCallback(async (nextRoomId: string) => {
    const normalized = normalizeRoomCode(nextRoomId);
    if (!normalized) {
      return;
    }

    setLoading(true);
    setJoinError(null);
    try {
      setRoom(await joinRoom(normalized));
    } catch (error) {
      setJoinError(error instanceof Error && error.message === 'room_not_found'
        ? 'That room code does not exist.'
        : 'Unable to join that room.');
    } finally {
      setLoading(false);
    }
  }, []);

  const createNewRoom = useCallback(async () => {
    setLoading(true);
    setJoinError(null);
    try {
      setRoom(await createRoom());
    } catch {
      setJoinError('Unable to create a room.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialRoomCode && !room && !loading && !attemptedInitialJoin.current) {
      attemptedInitialJoin.current = true;
      void openRoom(initialRoomCode);
    }
  }, [initialRoomCode, loading, openRoom, room]);

  if (!room) {
    return (
      <LandingPage
        error={joinError}
        loading={loading}
        onCreateRoom={createNewRoom}
        onJoinRoom={openRoom}
      />
    );
  }

  return <CanvasRoom room={room} onRoomChange={openRoom} onCreateRoom={createNewRoom} onLeaveRoom={() => setRoom(null)} />;
}

type CanvasRoomProps = {
  room: JoinRoomResponse;
  onRoomChange: (roomId: string) => Promise<void>;
  onCreateRoom: () => Promise<void>;
  onLeaveRoom: () => void;
};

function CanvasRoom({ room, onRoomChange, onCreateRoom, onLeaveRoom }: CanvasRoomProps) {
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#111827');
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [localDraft, setLocalDraft] = useState<StrokeObject | null>(null);

  const collaboration = useCollaborativeCanvas(room);
  const inviteLink = room.room.inviteUrl;

  const remoteDrafts = useMemo(
    () => collaboration.remoteUsers.map((user) => user.draft).filter((draft): draft is StrokeObject => Boolean(draft)),
    [collaboration.remoteUsers]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set('room', room.room.inviteCode);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [room.room.inviteCode]);

  useEffect(() => {
    return () => {
      window.history.replaceState(null, '', window.location.pathname);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT') {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          collaboration.redo();
        } else {
          collaboration.undo();
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        collaboration.redo();
      }

      if (event.key === 'p') {
        setTool('pen');
      }

      if (event.key === 'e') {
        setTool('eraser');
      }

      if (event.key === 'h') {
        setTool('pan');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [collaboration]);

  const beginStroke = useCallback((point: PointerPoint): StrokeObject => {
    const draft: StrokeObject = {
      id: makeObjectId(collaboration.profile.id),
      type: 'stroke',
      color,
      width: strokeWidth,
      points: [point],
        createdBy: collaboration.profile.id,
      createdAt: Date.now()
    };

    setLocalDraft(draft);
    collaboration.setDraft(draft);
    return draft;
  }, [collaboration, color, strokeWidth]);

  const updateStroke = useCallback((draft: StrokeObject) => {
    setLocalDraft(draft);
    collaboration.setDraft(draft);
  }, [collaboration]);

  const commitStroke = useCallback((draft: StrokeObject | null) => {
    if (!draft) {
      return;
    }

    setLocalDraft(null);
    collaboration.setDraft(null);

    if (draft.points.length > 1) {
      collaboration.addObject(draft);
    }
  }, [collaboration]);

  const eraseAt = useCallback((point: PointerPoint) => {
    const radius = Math.max(8, strokeWidth * 1.8);
    const hits = collaboration.objects
      .filter((object) => object.type === 'stroke' && isStrokeHit(object, point, radius))
      .map((object) => object.id);

    collaboration.deleteObjects(hits);
  }, [collaboration, strokeWidth]);

  return (
    <main className="appShell">
      <Toolbar
        tool={tool}
        color={color}
        width={strokeWidth}
        canUndo={collaboration.canUndo}
        canRedo={collaboration.canRedo}
        onToolChange={setTool}
        onColorChange={setColor}
        onWidthChange={setStrokeWidth}
        onUndo={collaboration.undo}
        onRedo={collaboration.redo}
        onClear={collaboration.clear}
        onResetView={() => setCamera(DEFAULT_CAMERA)}
      />

      <RoomControls
        roomId={room.room.inviteCode}
        inviteLink={inviteLink}
        status={collaboration.status}
        onRoomChange={(nextRoomId) => void onRoomChange(nextRoomId)}
        onCreateRoom={() => void onCreateRoom()}
        onLeaveRoom={onLeaveRoom}
      />
      <PresenceBar localUser={collaboration.localUser} remoteUsers={collaboration.remoteUsers} />

      <CanvasStage
        camera={camera}
        objects={collaboration.objects}
        localDraft={localDraft}
        remoteDrafts={remoteDrafts}
        remoteUsers={collaboration.remoteUsers}
        tool={tool}
        localUser={collaboration.localUser}
        onCameraChange={setCamera}
        onCursorChange={collaboration.setCursor}
        onBeginStroke={beginStroke}
        onUpdateStroke={updateStroke}
        onCommitStroke={commitStroke}
        onErase={eraseAt}
      />
    </main>
  );
}

function getInitialRoomId(): string | null {
  const params = new URLSearchParams(window.location.search);
  const room = normalizeRoomCode(params.get('room') || '');
  return room || null;
}

function isStrokeHit(stroke: StrokeObject, point: PointerPoint, radius: number): boolean {
  if (stroke.points.length === 0) {
    return false;
  }

  const threshold = radius + stroke.width / 2;
  if (stroke.points.length === 1) {
    return distance(stroke.points[0], point) <= threshold;
  }

  for (let index = 0; index < stroke.points.length - 1; index += 1) {
    if (distanceToSegment(point, stroke.points[index], stroke.points[index + 1]) <= threshold) {
      return true;
    }
  }

  return false;
}

function distance(a: PointerPoint, b: PointerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point: PointerPoint, start: PointerPoint, end: PointerPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return distance(point, start);
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
