import {
  createCapabilityAdminClient,
  type AdminClient,
  type AdminClientRequestOptions,
} from "@superfunctions/admin";
import { recFnAdminCapability } from "./capability.js";
import type {
  RecFnBotResourceInput,
  RecFnCreateWebhookInput,
  RecFnDeleteWebhookInput,
  RecFnGetBotInput,
  RecFnGetRecordingInput,
  RecFnListBotsInput,
} from "./types.js";

/** Function-scoped TypeScript client with named methods for every RecFn operation. */
export function createRecFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(recFnAdminCapability, adminClient);
  return Object.assign(client, {
    bots: {
      list: (input: RecFnListBotsInput = {}, options?: AdminClientRequestOptions) => client.invoke("recfn.bots.list", input, options),
      get: (input: RecFnGetBotInput, options?: AdminClientRequestOptions) => client.invoke("recfn.bots.get", input, options),
      leave: (input: RecFnGetBotInput, options?: AdminClientRequestOptions) => client.invoke("recfn.bots.leave", input, options),
      delete: (input: RecFnGetBotInput, options?: AdminClientRequestOptions) => client.invoke("recfn.bots.delete", input, options),
    },
    recordings: {
      list: (input: RecFnBotResourceInput, options?: AdminClientRequestOptions) => client.invoke("recfn.recordings.list", input, options),
      get: (input: RecFnGetRecordingInput, options?: AdminClientRequestOptions) => client.invoke("recfn.recordings.get", input, options),
    },
    transcripts: {
      get: (input: RecFnGetRecordingInput, options?: AdminClientRequestOptions) => client.invoke("recfn.transcripts.get", input, options),
    },
    participants: {
      list: (input: RecFnBotResourceInput, options?: AdminClientRequestOptions) => client.invoke("recfn.participants.list", input, options),
    },
    chat: {
      list: (input: RecFnBotResourceInput, options?: AdminClientRequestOptions) => client.invoke("recfn.chat.list", input, options),
    },
    metadata: {
      get: (input: RecFnBotResourceInput, options?: AdminClientRequestOptions) => client.invoke("recfn.metadata.get", input, options),
    },
    analytics: {
      get: (input: RecFnGetRecordingInput, options?: AdminClientRequestOptions) => client.invoke("recfn.analytics.get", input, options),
    },
    webhooks: {
      list: (options?: AdminClientRequestOptions) => client.invoke("recfn.webhooks.list", {}, options),
      create: (input: RecFnCreateWebhookInput, options?: AdminClientRequestOptions) => client.invoke("recfn.webhooks.create", input, options),
      delete: (input: RecFnDeleteWebhookInput, options?: AdminClientRequestOptions) => client.invoke("recfn.webhooks.delete", input, options),
    },
  });
}
