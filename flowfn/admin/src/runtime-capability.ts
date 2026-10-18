import type { AdminObjectSchema, AdminOperationDefinition, AdminResourceDefinition } from '@superfunctions/admin';
const text = { type: 'string', minLength: 1 } as const;
const integer = { type: 'integer', minimum: 0 } as const;
const object = (properties: AdminObjectSchema['properties'], required: string[] = []): AdminObjectSchema => ({ type: 'object', properties, required, additionalProperties: false });
const page = { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: integer, cursor: { type: 'string', pattern: '^[0-9]+$', maxLength: 16 } } as const;
const id = object({ id: text }, ['id']);
const executionId = object({ workflowId: text, id: text }, ['workflowId', 'id']);
const workflow = object({ id: text, name: text }, ['id', 'name']);
const execution = object({
  id: text, workflowId: text, status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
  input: {}, output: {}, state: {}, error: {}, waiting: {}, waitingFor: {}, compensationErrors: {},
  startedAt: integer, completedAt: integer, createdAt: integer, updatedAt: integer,
}, ['id', 'workflowId', 'status', 'input', 'startedAt']);
const stream = object({ id: text, name: text, length: integer, groups: integer, lag: integer }, ['id', 'name', 'length', 'groups']);
const schedule = object({ id: text, name: text, nextRun: text, count: integer, paused: { type: 'boolean' }, lastError: { type: 'string' } }, ['id', 'name', 'nextRun', 'count', 'paused']);
const list = (item: AdminObjectSchema) => object({ items: { type: 'array', items: item }, nextCursor: { type: ['string', 'null'] } }, ['items', 'nextCursor']);
const item = (schema: AdminObjectSchema) => object({ item: schema }, ['item']);
const accepted = object({ accepted: { type: 'boolean', const: true } }, ['accepted']);
const executionRedaction = { outputFields: ['input', 'output', 'state', 'error', 'waiting', 'waitingFor', 'compensationErrors'] };

function read<const Id extends string>(operationId: Id, resource: string, title: string, inputSchema: AdminObjectSchema, outputSchema: AdminObjectSchema, collection = false, sensitive: boolean | string[] = false) {
  return { id: operationId, title, description: `${title} through the environment-owned FlowFn runtime.`, inputSchema, outputSchema,
    route: { method: 'GET', path: `/resources/${resource}${collection ? '' : '/:id'}` }, permission: `flowfn.${resource}.read`, minimumScope: 'environment',
    safety: { classification: 'read', idempotent: true, requiresConfirmation: false, audit: 'required' },
    ...(sensitive ? { redaction: { outputFields: Array.isArray(sensitive) ? sensitive : executionRedaction.outputFields } } : {}),
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, target: { resource, ...(collection ? { collection: true } : { idInput: 'id' }) },
  } as const satisfies AdminOperationDefinition;
}
function action<const Id extends string>(operationId: Id, resource: string, title: string, inputSchema: AdminObjectSchema, outputSchema = accepted) {
  const name = operationId.split('.').at(-1)!;
  return { id: operationId, title, description: `${title} through FlowFn's public runtime API.`, inputSchema, outputSchema,
    route: { method: 'POST', path: `/resources/${resource}/actions/${name}` }, permission: `flowfn.${resource}.${name}`, minimumScope: 'environment',
    safety: { classification: 'write', idempotent: false, requiresConfirmation: true, audit: 'required', confirmation: { method: 'recent-auth', risk: 'high', maxAgeSeconds: 300, reason: 'This action changes workflow or scheduled execution.' } },
    redaction: { inputFields: ['data', 'decision'], ...executionRedaction },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, target: { resource, idInput: 'id' },
  } as const satisfies AdminOperationDefinition;
}
export const runtimeAdminResources = [
  ['workflows', 'Workflows', ['id', 'name'], []],
  ['workflow-executions', 'Workflow executions', ['id', 'workflowId', 'status', 'startedAt'], executionRedaction.outputFields],
  ['streams', 'Streams', ['id', 'name', 'length', 'groups', 'lag'], []],
  ['schedules', 'Schedules', ['id', 'name', 'nextRun', 'count', 'paused'], ['lastError']],
].map(([id, label, displayFields, sensitiveFields]) => ({ id, label, description: `${label} in this FlowFn environment.`, icon: `flowfn:${id}`, risk: 'sensitive', minimumScope: 'environment', idField: 'id', displayFields, searchableFields: ['id'], filterableFields: [], sortableFields: ['id'], sensitiveFields })) as AdminResourceDefinition[];

export const runtimeAdminOperations = [
  read('flowfn.workflows.list', 'workflows', 'List workflows', object(page), list(workflow), true),
  read('flowfn.workflow-executions.list', 'workflow-executions', 'List workflow executions', object({ ...page, workflowId: text, status: execution.properties!.status! }, ['workflowId']), list(execution), true, true),
  read('flowfn.workflow-executions.get', 'workflow-executions', 'Get workflow execution', executionId, item(execution), false, true),
  action('flowfn.workflow-executions.cancel', 'workflow-executions', 'Cancel workflow execution', executionId),
  action('flowfn.workflow-executions.retry', 'workflow-executions', 'Retry workflow execution', executionId, item(execution)),
  action('flowfn.workflow-executions.signal', 'workflow-executions', 'Signal workflow execution', object({ ...executionId.properties, event: text, data: {} }, ['workflowId', 'id', 'event'])),
  action('flowfn.workflow-executions.approve', 'workflow-executions', 'Approve workflow execution', object({ ...executionId.properties, decision: object({ approved: { type: 'boolean' }, approver: text, reason: text, notes: text }, ['approved']) }, ['workflowId', 'id', 'decision'])),
  action('flowfn.workflows.recover', 'workflows', 'Recover abandoned executions', id, object({ recovered: integer }, ['recovered'])),
  read('flowfn.streams.list', 'streams', 'List streams', object(page), list(stream), true),
  read('flowfn.streams.get', 'streams', 'Get stream', id, item(stream)),
  read('flowfn.schedules.list', 'schedules', 'List schedules', object(page), list(schedule), true, ['lastError']),
  action('flowfn.schedules.pause', 'schedules', 'Pause schedule', id),
  action('flowfn.schedules.resume', 'schedules', 'Resume schedule', id),
  action('flowfn.schedules.cancel', 'schedules', 'Cancel schedule', id),
] as const;
