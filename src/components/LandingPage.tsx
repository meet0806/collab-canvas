import { FormEvent, useState } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import { normalizeRoomCode } from '../collab/id';

type LandingPageProps = {
  error: string | null;
  loading: boolean;
  onCreateRoom: () => Promise<void>;
  onJoinRoom: (roomId: string) => Promise<void>;
};

export function LandingPage({ error, loading, onCreateRoom, onJoinRoom }: LandingPageProps) {
  const [roomCode, setRoomCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRoomCode(roomCode);

    if (!normalized) {
      setLocalError('Enter a room code or invite link.');
      return;
    }

    setLocalError(null);
    await onJoinRoom(normalized);
  };

  return (
    <main className="landingShell">
      <section className="landingHero">
        <div className="landingCopy">
          <p>Realtime Collaborative Canvas</p>
          <h1>Start a shared whiteboard or join with a room code.</h1>
        </div>

        <form className="joinPanel" onSubmit={submit}>
          <label>
            <span>Room code or invite link</span>
            <input
              value={roomCode}
              spellCheck={false}
              placeholder="DESIGN-REVIEW"
              onChange={(event) => {
                setRoomCode(event.target.value);
                setLocalError(null);
              }}
            />
          </label>

          {localError || error ? <div className="joinError">{localError ?? error}</div> : null}

          <div className="landingActions">
            <button className="primaryAction" type="submit" disabled={loading}>
              <ArrowRight size={18} />
              <span>{loading ? 'Joining' : 'Join room'}</span>
            </button>
            <button className="secondaryAction" type="button" disabled={loading} onClick={() => void onCreateRoom()}>
              <Plus size={18} />
              <span>{loading ? 'Creating' : 'Create room'}</span>
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
