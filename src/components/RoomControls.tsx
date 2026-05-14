import { FormEvent, useEffect, useState } from 'react';
import { Copy, LogOut, Plus, Wifi, WifiOff } from 'lucide-react';
import { ConnectionStatus } from '../types';
import { normalizeRoomCode } from '../collab/id';

type RoomControlsProps = {
  roomId: string;
  inviteLink: string;
  status: ConnectionStatus;
  onRoomChange: (roomId: string) => void;
  onCreateRoom: () => void;
  onLeaveRoom: () => void;
};

export function RoomControls({ roomId, inviteLink, status, onRoomChange, onCreateRoom, onLeaveRoom }: RoomControlsProps) {
  const [draftRoom, setDraftRoom] = useState(roomId);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraftRoom(roomId);
    window.localStorage.setItem('collab-canvas:last-room', roomId);
    setCopied(false);
  }, [roomId]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRoomCode(draftRoom);
    if (normalized) {
      onRoomChange(normalized);
    }
  };

  const copyInvite = async () => {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(inviteLink);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <form className="roomControls" onSubmit={handleSubmit}>
      <div className={`statusPill status-${status}`}>
        {status === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
        <span>{status}</span>
      </div>
      <div className="roomCode" title="Room code">
        {roomId.toUpperCase()}
      </div>
      <input
        value={draftRoom}
        aria-label="Room code"
        spellCheck={false}
        onChange={(event) => setDraftRoom(event.target.value)}
      />
      <button type="submit">Join</button>
      <button className="roomIconButton" type="button" title="Create room" aria-label="Create room" onClick={onCreateRoom}>
        <Plus size={16} />
      </button>
      <button className="roomIconButton" type="button" title="Copy invite link" aria-label="Copy invite link" onClick={copyInvite}>
        <Copy size={16} />
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <button className="roomIconButton" type="button" title="Leave room" aria-label="Leave room" onClick={onLeaveRoom}>
        <LogOut size={16} />
      </button>
    </form>
  );
}
