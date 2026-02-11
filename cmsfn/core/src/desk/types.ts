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
  contentfn: { baseUrl: string; /** Optional WebSocket URL for ContentFn realtime (e.g. ws://host/contentfn/realtime). */ realtimeUrl?: string };
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
