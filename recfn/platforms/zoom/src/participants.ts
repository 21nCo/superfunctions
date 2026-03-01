import type { Participant, ParticipantRole } from 'recfn';
import type { ZoomMeetingSdk, ZoomParticipantInfo } from './meeting-sdk.js';

export interface ParticipantTracker {
  getAll(): Participant[];
  onJoin(cb: (p: Participant) => void): void;
  onLeave(cb: (id: string) => void): void;
  setBotId(botId: string): void;
}

function toParticipant(
  info: ZoomParticipantInfo,
  botId: string,
): Participant {
  const role: ParticipantRole = info.isHost ? 'host' : 'attendee';
  return {
    id: info.participantId,
    botId,
    name: info.name,
    email: info.email,
    role,
    joinedAt: new Date().toISOString(),
    leftAt: undefined,
    consent: 'pending',
  };
}

export function createParticipantTracker(
  sdk: ZoomMeetingSdk,
): ParticipantTracker {
  const participants = new Map<string, Participant>();
  const joinCallbacks: Array<(p: Participant) => void> = [];
  const leaveCallbacks: Array<(id: string) => void> = [];
  let currentBotId = '';

  sdk.on('participant-joined', (info: ZoomParticipantInfo) => {
    const participant = toParticipant(info, currentBotId);
    participants.set(info.participantId, participant);
    for (const cb of joinCallbacks) {
      cb(participant);
    }
  });

  sdk.on('participant-left', (info: { participantId: string }) => {
    const participant = participants.get(info.participantId);
    if (participant) {
      participant.leftAt = new Date().toISOString();
    }
    for (const cb of leaveCallbacks) {
      cb(info.participantId);
    }
  });

  return {
    getAll(): Participant[] {
      return Array.from(participants.values());
    },

    onJoin(cb: (p: Participant) => void): void {
      joinCallbacks.push(cb);
    },

    onLeave(cb: (id: string) => void): void {
      leaveCallbacks.push(cb);
    },

    setBotId(botId: string): void {
      currentBotId = botId;
      for (const p of participants.values()) {
        p.botId = botId;
      }
    },
  };
}

export function snapshotParticipants(
  sdk: ZoomMeetingSdk,
  botId: string,
): Participant[] {
  const sdkParticipants = sdk.getParticipants();
  return sdkParticipants.map((info) => toParticipant(info, botId));
}
