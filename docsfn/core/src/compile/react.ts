import { compileMarkdown, type CompileMarkdownInput } from "../markdown";

export function compileReactContent(
  input: Omit<CompileMarkdownInput, "framework">
) {
  return compileMarkdown({
    ...input,
    framework: "react",
  });
}
