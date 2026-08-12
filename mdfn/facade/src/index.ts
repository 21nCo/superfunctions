export * from "@mdfn/core";
export * from "@mdfn/markdown";
export * from "@mdfn/render";
export * from "@mdfn/extensions";

import { createEditor, type CreateEditorInput, type EditorController } from "@mdfn/core";
import { createMarkdownProjector, type MarkdownOptions } from "@mdfn/markdown";
import { defaultExtensions } from "@mdfn/extensions";

export function createMdfn(
  input: Omit<CreateEditorInput, "projector" | "extensions"> & { readonly markdownOptions?: MarkdownOptions },
): EditorController {
  return createEditor({
    ...input,
    projector: createMarkdownProjector({ ...input.markdownOptions, extensions: defaultExtensions }),
    extensions: defaultExtensions,
  });
}

export const MDFN_VERSION = "0.1.0" as const;
