import { RoomUser } from '../types';

type PresenceBarProps = {
  localUser: RoomUser;
  remoteUsers: RoomUser[];
};

export function PresenceBar({ localUser, remoteUsers }: PresenceBarProps) {
  const users = [localUser, ...remoteUsers].slice(0, 6);

  return (
    <div className="presenceBar" aria-label="Connected users">
      {users.map((user) => (
        <div key={user.profile.id} className="avatar" title={user.displayName} style={{ backgroundColor: user.color }}>
          U{user.participantNumber}
        </div>
      ))}
      <span>{remoteUsers.length + 1}</span>
    </div>
  );
}
