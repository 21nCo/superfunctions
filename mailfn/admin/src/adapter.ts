import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { mailFnAdminCapability } from "./index.js";
import type { MailFnAdminService } from "./types.js";

function bind<TInput>(
  handler: (input: TInput, context: AdminOperationContext) => unknown,
) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

/** Maps each declared MailFn operation to one explicit domain method. */
export function createMailFnAdminAdapter(
  service: MailFnAdminService,
): AdminCapabilityAdapter<typeof mailFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(mailFnAdminCapability, {
    "mailfn.projects.list": bind(service.listProjects),
    "mailfn.projects.get": bind(service.getProject),
    "mailfn.inboxes.list": bind(service.listInboxes),
    "mailfn.inboxes.get": bind(service.getInbox),
    "mailfn.messages.list": bind(service.listMessages),
    "mailfn.messages.get": bind(service.getMessage),
    "mailfn.threads.list": bind(service.listThreads),
    "mailfn.threads.get": bind(service.getThread),
    "mailfn.drafts.list": bind(service.listDrafts),
    "mailfn.drafts.get": bind(service.getDraft),
    "mailfn.attachments.list": bind(service.listAttachments),
    "mailfn.attachments.get": bind(service.getAttachment),
    "mailfn.credentials.list": bind(service.listCredentials),
    "mailfn.credentials.get": bind(service.getCredential),
    "mailfn.domains-routes.list": bind(service.listDomains),
    "mailfn.domains-routes.get": bind(service.getDomain),
    "mailfn.webhooks.list": bind(service.listWebhooks),
    "mailfn.webhooks.get": bind(service.getWebhook),
    "mailfn.retention.list": bind(service.listRetention),
    "mailfn.retention.get": bind(service.getRetention),
    "mailfn.quotas.list": bind(service.listQuotas),
    "mailfn.quotas.get": bind(service.getQuota),
    "mailfn.compliance-audit.list": bind(service.listAuditEvents),
    "mailfn.compliance-audit.get": bind(service.getAuditEvent),
    "mailfn.inboxes.create-inbox": bind(service.createInbox),
    "mailfn.inboxes.expire-inbox": bind(service.expireInbox),
    "mailfn.messages.label-message": bind(service.labelMessage),
    "mailfn.drafts.send-draft": bind(service.sendDraft),
    "mailfn.messages.reply-draft": bind(service.createReplyDraft),
    "mailfn.domains-routes.manage-domain": bind(service.manageDomain),
    "mailfn.webhooks.create-webhook": bind(service.createWebhook),
    "mailfn.credentials.rotate-credential": bind(service.rotateCredential),
    "mailfn.retention.purge": bind(service.purgeRetention),
  });
}

export const createAdminAdapter = createMailFnAdminAdapter;
