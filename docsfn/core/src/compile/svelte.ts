import { compileMarkdown, type CompileMarkdownInput } from "../markdown";

export function compileSvelteContent(
  input: Omit<CompileMarkdownInput, "framework">
) {
  return compileMarkdown({
    ...input,
    framework: "svelte",
  });
}
