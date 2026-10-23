import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { recFnAdminCapability } from "./capability.js";
import type { RecFnAdminService } from "./types.js";

function bind<TInput, TOutput>(
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

/** Maps every declared RecFn operation to an explicit typed domain method. */
export function createRecFnAdminAdapter(
  service: RecFnAdminService,
): AdminCapabilityAdapter<typeof recFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(recFnAdminCapability, {
    "recfn.bots.list": bind(service.listBots),
    "recfn.bots.get": bind(service.getBot),
    "recfn.bots.leave": bind(service.leaveBot),
    "recfn.bots.delete": bind(service.deleteBot),
    "recfn.recordings.list": bind(service.listRecordings),
    "recfn.recordings.get": bind(service.getRecording),
    "recfn.transcripts.get": bind(service.getTranscript),
    "recfn.participants.list": bind(service.listParticipants),
    "recfn.chat.list": bind(service.listChat),
    "recfn.metadata.get": bind(service.getMetadata),
    "recfn.analytics.get": bind(service.getAnalytics),
    "recfn.webhooks.list": bind(service.listWebhooks),
    "recfn.webhooks.create": bind(service.createWebhook),
    "recfn.webhooks.delete": bind(service.deleteWebhook),
  });
}

export const createAdminAdapter = createRecFnAdminAdapter;
