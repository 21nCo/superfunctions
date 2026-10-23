import { createCapabilityAdminClient, type AdminClient, type AdminClientRequestOptions } from "@superfunctions/admin";
import { flowFnAdminCapability } from "./capability.js";
import type {
  FlowFnCleanDeadLettersInput,
  FlowFnDeleteDeadLetterInput,
  FlowFnEnqueueJobInput,
  FlowFnGetDeadLetterInput,
  FlowFnGetJobInput,
  FlowFnGetQueueInput,
  FlowFnGetWorkerInput,
  FlowFnListDeadLettersInput,
  FlowFnListEventsInput,
  FlowFnListJobsInput,
  FlowFnListQueuesInput,
  FlowFnListWorkersInput,
  FlowFnQueueActionInput,
  FlowFnRedriveDeadLetterInput,
  FlowFnWorkerActionInput,
} from "./types.js";

export function createFlowFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(flowFnAdminCapability, adminClient);
  return Object.assign(client, {
    queues: {
      list: (input: FlowFnListQueuesInput = {}, options?: AdminClientRequestOptions) => client.invoke("flowfn.queues.list", input, options),
      get: (input: FlowFnGetQueueInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.queues.get", input, options),
      pause: (input: FlowFnQueueActionInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.queues.pause", input, options),
      resume: (input: FlowFnQueueActionInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.queues.resume", input, options),
    },
    jobs: {
      list: (input: FlowFnListJobsInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.jobs.list", input, options),
      get: (input: FlowFnGetJobInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.jobs.get", input, options),
      enqueue: (input: FlowFnEnqueueJobInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.jobs.enqueue", input, options),
    },
    workers: {
      list: (input: FlowFnListWorkersInput = {}, options?: AdminClientRequestOptions) => client.invoke("flowfn.workers.list", input, options),
      get: (input: FlowFnGetWorkerInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.workers.get", input, options),
      run: (input: FlowFnWorkerActionInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.workers.run", input, options),
      close: (input: FlowFnWorkerActionInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.workers.close", input, options),
    },
    deadLetters: {
      list: (input: FlowFnListDeadLettersInput = {}, options?: AdminClientRequestOptions) => client.invoke("flowfn.dead-letters.list", input, options),
      get: (input: FlowFnGetDeadLetterInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.dead-letters.get", input, options),
      redrive: (input: FlowFnRedriveDeadLetterInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.dead-letters.redrive", input, options),
      delete: (input: FlowFnDeleteDeadLetterInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.dead-letters.delete", input, options),
      clean: (input: FlowFnCleanDeadLettersInput, options?: AdminClientRequestOptions) => client.invoke("flowfn.dead-letters.clean", input, options),
    },
    events: {
      list: (input: FlowFnListEventsInput = {}, options?: AdminClientRequestOptions) => client.invoke("flowfn.events.list", input, options),
    },
  });
}
