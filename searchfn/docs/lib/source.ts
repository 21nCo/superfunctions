import { docs } from "@/.source";
import { loader } from "fumadocs-core/source";
import type { SourceConfig, VirtualFile } from "fumadocs-core/source";

const fumadocsSource = docs.toFumadocsSource();

export const source = loader({
  baseUrl: "/docs",
  source: {
    files: (fumadocsSource as unknown as { files: () => VirtualFile<SourceConfig>[] }).files(),
  },
});
