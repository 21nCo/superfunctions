import type { ContentfnDatabase as Adapter } from "./database.js";
import { enqueueWebhookDelivery } from "./webhookQueue.js";
import { nowISO } from "../time/clock.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";

export interface EventsStorageConfig {
  db: Adapter;
  actor?: { subject: string };
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
  const actor = input.actor ?? config.actor;
  const eventId = generateEventId();
  const timestamp = nowISO();

  const event: ContentfnEvent = {
    eventId,
    dataset: input.dataset,
    type: input.type,
    timestamp,
    actor,
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
      actor: actor || null,
      docId: input.docId || null,
      rev: input.rev || null,
      changedPaths: input.changedPaths || [],
    },
  });

  const hooks = await config.db.findMany({ model: CONTENTFN_TABLE_NAMES.webhooks, where: [{ field: "dataset", operator: "eq", value: input.dataset }] });
  for (const hook of hooks) {
    if (Array.isArray(hook.events) && hook.events.includes(input.type)) {
      await enqueueWebhookDelivery(config, { eventId, webhookId: hook.webhookId as string });
    }
  }
  return event;
}
