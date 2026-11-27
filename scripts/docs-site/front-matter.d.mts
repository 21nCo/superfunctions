export declare class UnsupportedFrontMatterError extends Error {
  readonly code: "DOCS_FRONTMATTER_UNSUPPORTED";
  readonly label: string;
  readonly sourcePath: string;
  constructor(label: string, sourcePath: string);
}
export declare function frontMatterLanguage(source: string): string | undefined;
export declare function assertYamlFrontMatter(source: string, sourcePath: string): void;
