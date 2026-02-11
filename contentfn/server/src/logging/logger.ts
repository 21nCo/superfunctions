export interface ContentfnLogEntry {
  timestamp: string;
  action: string;
  dataset?: string;
  docId?: string;
  actor?: string;
  assetId?: string;
  size?: number;
  contentType?: string;
  error?: string;
  [key: string]: unknown;
}

export type ContentfnLogSink = (entry: ContentfnLogEntry) => void;

export function createLogger(sink?: ContentfnLogSink): ContentfnLogger {
  return new ContentfnLogger(sink ?? defaultSink);
}

function defaultSink(_entry: ContentfnLogEntry): void {
  // no-op by default; deployers attach their own sink
}

export class ContentfnLogger {
  private sink: ContentfnLogSink;

  constructor(sink: ContentfnLogSink) {
    this.sink = sink;
  }

  logMutation(info: {
    action: string;
    dataset?: string;
    docId?: string;
    actor?: string;
  }): void {
    this.sink({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      action: info.action,
      dataset: info.dataset,
      docId: info.docId,
      actor: info.actor,
    });
  }

  logAssetUpload(info: {
    dataset: string;
    assetId?: string;
    size: number;
    contentType: string;
  }): void {
    this.sink({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      action: "assets.upload",
      dataset: info.dataset,
      assetId: info.assetId,
      size: info.size,
      contentType: info.contentType,
    });
  }

  logWebhookFailure(info: {
    dataset: string;
    webhookUrl: string;
    error: string;
  }): void {
    this.sink({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      action: "webhooks.delivery_failed",
      dataset: info.dataset,
      error: info.error,
    });
  }
}
