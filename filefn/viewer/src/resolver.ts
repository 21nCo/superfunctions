export type RenderIntent = 'thumbnail' | 'preview' | 'full' | 'download';
export type RenderState = 'ready' | 'processing' | 'pending-local' | 'unsupported';
export type RenderPlaceholderKind = 'generic-file' | 'pdf-processing' | 'unsupported-preview';

export interface RenderDescriptor {
  fileId: string;
  versionId: string;
  intent: RenderIntent;
  state: RenderState;
  mimeType: string;
  name: string;
  size: number;
  source:
    | {
        mode: 'artifact';
        artifactId: string;
        artifactKind: string;
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'original';
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'placeholder';
        placeholderKind: RenderPlaceholderKind;
      };
  warnings?: string[];
}

export interface FileFnClientLike {
  resolveRenderable(input: {
    fileId: string;
    intent: RenderIntent;
    versionId?: string;
    preferLocal?: boolean;
  }): Promise<RenderDescriptor>;
}

export interface ViewerResolver {
  resolve(input: {
    fileId: string;
    intent: RenderIntent;
    versionId?: string;
    preferLocal?: boolean;
  }): Promise<RenderDescriptor>;
}

export interface ViewerSource {
  fileId: string;
  intent: RenderIntent;
  state: RenderState;
  mimeType: string;
  url?: string;
  placeholderKind?: RenderPlaceholderKind;
  revoke?: () => void;
}

function createBlobRevoke(url: string): (() => void) | undefined {
  if (!url.startsWith('blob:')) {
    return undefined;
  }
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return undefined;
  }
  return () => {
    URL.revokeObjectURL(url);
  };
}

export function createViewerResolver(client: FileFnClientLike): ViewerResolver {
  return {
    async resolve(input) {
      return client.resolveRenderable(input);
    },
  };
}

export async function resolveViewerSource(input: {
  client: FileFnClientLike;
  fileId: string;
  intent: RenderIntent;
  versionId?: string;
  preferLocal?: boolean;
}): Promise<ViewerSource> {
  const descriptor = await input.client.resolveRenderable({
    fileId: input.fileId,
    intent: input.intent,
    versionId: input.versionId,
    preferLocal: input.preferLocal,
  });

  if (descriptor.source.mode === 'placeholder') {
    return {
      fileId: descriptor.fileId,
      intent: descriptor.intent,
      state: descriptor.state,
      mimeType: descriptor.mimeType,
      placeholderKind: descriptor.source.placeholderKind,
    };
  }

  return {
    fileId: descriptor.fileId,
    intent: descriptor.intent,
    state: descriptor.state,
    mimeType: descriptor.mimeType,
    url: descriptor.source.url,
    revoke: createBlobRevoke(descriptor.source.url),
  };
}
