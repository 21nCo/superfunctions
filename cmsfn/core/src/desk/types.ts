/**
 * CmsFn desk and studio config types (SPEC.md).
 */

export type CmsfnDeskNode =
  | { kind: "group"; title: string; children: CmsfnDeskNode[] }
  | {
      kind: "documentList";
      title: string;
      dataset: string;
      types: string[];
      defaultOrder?: { field: string; direction: "asc" | "desc" }[];
    }
  | { kind: "singleton"; title: string; dataset: string; type: string; id: string }
  | { kind: "divider" };

export interface CmsfnStudioConfig {
  /** Explicit standalone trust: ContentFn query authorization enforces dataset/type reads. CMS URL always takes precedence. */
  references?: { authorization: "contentfn" };
  contentfn: { baseUrl: string; /** Optional authenticated ContentFn HTTP(S) /contentfn/events endpoint or host WebSocket URL. Browser cookies require matching CORS policy; header tokens need a same-origin proxy. */ realtimeUrl?: string };
  /** When set, studio can call POST /cmsfn/publish and /cmsfn/unpublish for gated publish. */
  cmsfn?: { apiUrl: string };
  datasets: Array<{ name: string; label?: string }>;
  desk: CmsfnDeskNode;
  preview?: {
    enabled: boolean;
    targetOrigin: string;
    resolveUrl: (doc: unknown) => string;
  };
  auth: {
    kind: "authfn" | "custom";
  };
  limits?: {
    maxUploadBytes?: number;
    maxRichtextBlocks?: number;
  };
}
