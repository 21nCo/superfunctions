import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { flowFnAdminCapability } from "./capability.js";
import type { FlowFnAdminService } from "./types.js";

function bind<TInput, TOutput>(handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

export function createFlowFnAdminAdapter(service: FlowFnAdminService): AdminCapabilityAdapter<typeof flowFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(flowFnAdminCapability, {
    "flowfn.queues.list": bind(service.listQueues),
    "flowfn.queues.get": bind(service.getQueue),
    "flowfn.queues.pause": bind(service.pauseQueue),
    "flowfn.queues.resume": bind(service.resumeQueue),
    "flowfn.jobs.list": bind(service.listJobs),
    "flowfn.jobs.get": bind(service.getJob),
    "flowfn.jobs.enqueue": bind(service.enqueueJob),
    "flowfn.workers.list": bind(service.listWorkers),
    "flowfn.workers.get": bind(service.getWorker),
    "flowfn.workers.run": bind(service.runWorker),
    "flowfn.workers.close": bind(service.closeWorker),
    "flowfn.dead-letters.list": bind(service.listDeadLetters),
    "flowfn.dead-letters.get": bind(service.getDeadLetter),
    "flowfn.dead-letters.redrive": bind(service.redriveDeadLetter),
    "flowfn.dead-letters.delete": bind(service.deleteDeadLetter),
    "flowfn.dead-letters.clean": bind(service.cleanDeadLetters),
    "flowfn.events.list": bind(service.listEvents),
  });
}

export const createAdminAdapter = createFlowFnAdminAdapter;
