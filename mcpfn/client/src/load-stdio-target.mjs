// Plain JavaScript on purpose: `#stdio-target` resolves through package.json
// `imports`, which points at built files, so TypeScript must not resolve it
// (a tsconfig `paths` alias would also redirect bundlers that read tsconfig).
// The literal specifier lets bundlers apply export conditions: `node` loads the
// stdio entry, every other runtime gets the `stdio-unavailable` stub.
export function loadStdioTarget() {
  return import("#stdio-target");
}
