import type { Adapter } from "@superfunctions/db";
import { nowISO } from "../time/clock.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";

export interface EventsStorageConfig {
  db: Adapter;
}

export interface ContentfnEvent {
  eventId: string;
  dataset: string;
  type: string;
  timestamp: string;
  actor?: { subject: string };
  docId?: string;
  rev?: string;
  changedPaths?: string[];
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;
}

export async function appendEvent(
  config: EventsStorageConfig,
  input: {
    dataset: string;
    type: string;
    actor?: { subject: string };
    docId?: string;
    rev?: string;
    changedPaths?: string[];
  }
): Promise<ContentfnEvent> {
  const eventId = generateEventId();
  const timestamp = nowISO();

  const event: ContentfnEvent = {
    eventId,
    dataset: input.dataset,
    type: input.type,
    timestamp,
    actor: input.actor,
    docId: input.docId,
    rev: input.rev,
    changedPaths: input.changedPaths || [],
  };

  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.events,
    data: {
      eventId,
      dataset: input.dataset,
      type: input.type,
      timestamp,
      actor: input.actor || null,
      docId: input.docId || null,
      rev: input.rev || null,
      changedPaths: input.changedPaths || [],
    },
  });

  return event;
}
