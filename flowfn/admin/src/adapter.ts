import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { flowFnAdminCapability } from "./capability.js";
import type { FlowFnAdminService } from "./types.js";

function bind<TInput, TOutput>(
  service: FlowFnAdminService,
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) =>
    handler.call(service, input as TInput, context);
}

export function createFlowFnAdminAdapter(
  service: FlowFnAdminService,
): AdminCapabilityAdapter<typeof flowFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(flowFnAdminCapability, {
    'flowfn.workflows.list': bind(service, service.listWorkflows),
    'flowfn.workflows.recover': bind(service, service.recoverWorkflow),
    'flowfn.workflow-executions.list': bind(service, service.listExecutions),
    'flowfn.workflow-executions.get': bind(service, service.getExecution),
    'flowfn.workflow-executions.cancel': bind(service, service.cancelExecution),
    'flowfn.workflow-executions.retry': bind(service, service.retryExecution),
    'flowfn.workflow-executions.signal': bind(service, service.signalExecution),
    'flowfn.workflow-executions.approve': bind(service, service.approveExecution),
    'flowfn.streams.list': bind(service, service.listStreams),
    'flowfn.streams.get': bind(service, service.getStream),
    'flowfn.schedules.list': bind(service, service.listSchedules),
    'flowfn.schedules.pause': bind(service, service.pauseSchedule),
    'flowfn.schedules.resume': bind(service, service.resumeSchedule),
    'flowfn.schedules.cancel': bind(service, service.cancelSchedule),
    "flowfn.queues.list": bind(service, service.listQueues),
    "flowfn.queues.get": bind(service, service.getQueue),
    "flowfn.queues.pause": bind(service, service.pauseQueue),
    "flowfn.queues.resume": bind(service, service.resumeQueue),
    "flowfn.jobs.list": bind(service, service.listJobs),
    "flowfn.jobs.get": bind(service, service.getJob),
    "flowfn.jobs.enqueue": bind(service, service.enqueueJob),
    "flowfn.workers.list": bind(service, service.listWorkers),
    "flowfn.workers.get": bind(service, service.getWorker),
    "flowfn.workers.run": bind(service, service.runWorker),
    "flowfn.workers.close": bind(service, service.closeWorker),
    "flowfn.dead-letters.list": bind(service, service.listDeadLetters),
    "flowfn.dead-letters.get": bind(service, service.getDeadLetter),
    "flowfn.dead-letters.redrive": bind(service, service.redriveDeadLetter),
    "flowfn.dead-letters.delete": bind(service, service.deleteDeadLetter),
    "flowfn.dead-letters.clean": bind(service, service.cleanDeadLetters),
    "flowfn.events.list": bind(service, service.listEvents),
  });
}

export const createAdminAdapter = createFlowFnAdminAdapter;
