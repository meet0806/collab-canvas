import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import {
  CanvasObject,
  ConnectionStatus,
  CursorState,
  CursorVariant,
  RoomUser,
  StrokeObject,
  UserProfile
} from '../types';
import { JoinRoomResponse } from './api';

type PresenceWireUser = {
  clientId: number;
  profile: UserProfile;
  cursor: CursorState | null;
  draft: StrokeObject | null;
  updatedAt?: number;
  displayName?: string;
  color?: string;
  participantNumber?: number;
  cursorVariant?: CursorVariant;
};

export type CollaborativeCanvasState = {
  profile: UserProfile;
  localUser: RoomUser;
  objects: CanvasObject[];
  remoteUsers: RoomUser[];
  status: ConnectionStatus;
  addObject: (object: CanvasObject) => void;
  deleteObjects: (ids: string[]) => void;
  clear: () => void;
  setCursor: (cursor: CursorState | null) => void;
  setDraft: (draft: StrokeObject | null) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

export function useCollaborativeCanvas(room: JoinRoomResponse): CollaborativeCanvasState {
  const localOrigin = useMemo(() => ({ roomId: room.room.id, origin: room.session.token }), [room.room.id, room.session.token]);
  const [objects, setObjects] = useState<CanvasObject[]>([]);
  const [remoteUsers, setRemoteUsers] = useState<RoomUser[]>([]);
  const [localUser, setLocalUser] = useState<RoomUser | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });

  const clientProfile = useMemo<UserProfile>(() => ({
    id: room.session.userId,
    name: room.session.displayName,
    color: room.session.color
  }), [room.session.color, room.session.displayName, room.session.userId]);

  const docRef = useRef<Y.Doc | null>(null);
  const objectsRef = useRef<Y.Map<CanvasObject> | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const cursorRef = useRef<CursorState | null>(null);
  const draftRef = useRef<StrokeObject | null>(null);

  const refreshHistory = useCallback(() => {
    const manager = undoRef.current;
    setHistoryState({
      canUndo: Boolean(manager?.undoStack.length),
      canRedo: Boolean(manager?.redoStack.length)
    });
  }, []);

  useEffect(() => {
    setStatus('connecting');
    setLocalUser(null);
    setRemoteUsers([]);

    const doc = new Y.Doc({ gc: true });
    const objectMap = doc.getMap<CanvasObject>('canvas-objects');
    const providerUrl = new URL(room.endpoints.sync);
    const provider = new WebsocketProvider(
      `${providerUrl.origin}/sync`,
      room.room.inviteCode,
      doc,
      {
        connect: true,
        params: Object.fromEntries(providerUrl.searchParams.entries())
      }
    );
    const undoManager = new Y.UndoManager(objectMap, {
      trackedOrigins: new Set([localOrigin]),
      captureTimeout: 600
    });

    docRef.current = doc;
    objectsRef.current = objectMap;
    providerRef.current = provider;
    undoRef.current = undoManager;

    provider.awareness.setLocalStateField('user', clientProfile);
    provider.awareness.setLocalStateField('cursor', null);
    provider.awareness.setLocalStateField('draft', null);

    const syncObjects = () => {
      const nextObjects = [...objectMap.values()].sort((a, b) => a.createdAt - b.createdAt);
      setObjects(nextObjects);
      refreshHistory();
    };

    const handleStatus = (event: { status: ConnectionStatus }) => {
      setStatus(event.status);
    };

    objectMap.observe(syncObjects);
    provider.on('status', handleStatus);
    undoManager.on('stack-item-added', refreshHistory);
    undoManager.on('stack-item-popped', refreshHistory);

    syncObjects();

    return () => {
      provider.awareness.setLocalState(null);
      objectMap.unobserve(syncObjects);
      provider.off('status', handleStatus);
      undoManager.off('stack-item-added', refreshHistory);
      undoManager.off('stack-item-popped', refreshHistory);
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
      undoRef.current = null;
      providerRef.current = null;
      objectsRef.current = null;
      docRef.current = null;
    };
  }, [clientProfile, localOrigin, refreshHistory, room]);

  useEffect(() => {
    let socket: WebSocket | null = new WebSocket(room.endpoints.presence);
    const wsUsers = new Map<string, PresenceWireUser>();
    let lastPayload = '';

    const commitPresence = () => {
      const now = Date.now();
      const combined = new Map<string, PresenceWireUser>();

      for (const user of wsUsers.values()) {
        combined.set(user.profile.id, user);
      }

      const ownPresence: PresenceWireUser = {
        clientId: room.session.participantNumber,
        profile: clientProfile,
        cursor: cursorRef.current,
        draft: draftRef.current,
        displayName: room.session.displayName,
        color: room.session.color,
        participantNumber: room.session.participantNumber,
        cursorVariant: room.session.cursorVariant,
        updatedAt: now
      };

      combined.set(clientProfile.id, ownPresence);

      const users = [...combined.values()]
        .sort((a, b) => a.clientId - b.clientId)
        .map((user, index): RoomUser => toRoomUser(user, index, clientProfile.id));

      setLocalUser(users.find((user) => user.isLocal) ?? null);
      setRemoteUsers(users.filter((user) => !user.isLocal));
    };

    const publishPresence = () => {
      const presence = {
        type: 'presence-update',
        clientId: room.session.participantNumber,
        profile: clientProfile,
        cursor: cursorRef.current,
        draft: draftRef.current,
        updatedAt: Date.now()
      };
      const payload = JSON.stringify(presence);

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        commitPresence();
        return;
      }

      if (payload !== lastPayload) {
        socket.send(payload);
        lastPayload = payload;
      }

      commitPresence();
    };

    const interval = window.setInterval(publishPresence, 50);

    socket.addEventListener('open', publishPresence);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data) as { type: string; users: PresenceWireUser[] };
      if (message.type !== 'presence-state') {
        return;
      }

      wsUsers.clear();
      for (const user of message.users) {
        wsUsers.set(user.profile.id, user);
      }

      commitPresence();
    });

    socket.addEventListener('close', () => {
      wsUsers.clear();
      commitPresence();
    });

    publishPresence();

    return () => {
      window.clearInterval(interval);
      cursorRef.current = null;
      draftRef.current = null;
      socket?.close();
      socket = null;
    };
  }, [clientProfile, room.endpoints.presence, room.session.color, room.session.cursorVariant, room.session.displayName, room.session.participantNumber]);

  const transact = useCallback((callback: (objectMap: Y.Map<CanvasObject>) => void) => {
    const doc = docRef.current;
    const objectMap = objectsRef.current;

    if (!doc || !objectMap) {
      return;
    }

    doc.transact(() => callback(objectMap), localOrigin);
  }, [localOrigin]);

  const addObject = useCallback((object: CanvasObject) => {
    transact((objectMap) => {
      objectMap.set(object.id, object);
    });
  }, [transact]);

  const deleteObjects = useCallback((ids: string[]) => {
    if (!ids.length) {
      return;
    }

    transact((objectMap) => {
      for (const id of ids) {
        objectMap.delete(id);
      }
    });
  }, [transact]);

  const clear = useCallback(() => {
    transact((objectMap) => {
      for (const id of objectMap.keys()) {
        objectMap.delete(id);
      }
    });
  }, [transact]);

  const setCursor = useCallback((cursor: CursorState | null) => {
    cursorRef.current = cursor;
  }, []);

  const setDraft = useCallback((draft: StrokeObject | null) => {
    draftRef.current = draft;
    providerRef.current?.awareness.setLocalStateField('draft', draft);
  }, []);

  const undo = useCallback(() => {
    undoRef.current?.undo();
    refreshHistory();
  }, [refreshHistory]);

  const redo = useCallback(() => {
    undoRef.current?.redo();
    refreshHistory();
  }, [refreshHistory]);

  const fallbackLocalUser = useMemo<RoomUser>(() => ({
    clientId: -1,
    profile: clientProfile,
    cursor: null,
    draft: null,
    displayName: room.session.displayName,
    color: room.session.color,
    participantNumber: room.session.participantNumber,
    cursorVariant: room.session.cursorVariant,
    isLocal: true
  }), [clientProfile, room.session.cursorVariant, room.session.displayName, room.session.participantNumber, room.session.color]);

  const activeLocalUser = localUser ?? fallbackLocalUser;

  return {
    profile: activeLocalUser.profile,
    localUser: activeLocalUser,
    objects,
    remoteUsers,
    status,
    addObject,
    deleteObjects,
    clear,
    setCursor,
    setDraft,
    undo,
    redo,
    canUndo: historyState.canUndo,
    canRedo: historyState.canRedo
  };
}

function toRoomUser(user: PresenceWireUser, index: number, localProfileId: string): RoomUser {
  const color = user.color ?? user.profile.color;
  const displayName = user.displayName ?? user.profile.name;

  return {
    ...user,
    cursor: user.cursor ?? null,
    draft: user.draft ?? null,
    profile: {
      ...user.profile,
      name: displayName,
      color
    },
    displayName,
    color,
    participantNumber: user.participantNumber ?? index + 1,
    cursorVariant: user.cursorVariant ?? 'arrow',
    isLocal: user.profile.id === localProfileId
  };
}
