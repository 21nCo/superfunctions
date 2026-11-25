import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(repoRoot, "uifn", "catalog", "generated", "catalog.json");
const outputPath = path.join(
  repoRoot,
  "uifn",
  "examples",
  "shared",
  "src",
  "catalog-accessibility.generated.ts"
);
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const rulesByProfile = new Map();
const accessibilityEntries = catalog.primitives.map(({ id, accessibility }) => {
  const { profile, primitiveNotes, rules } = accessibility;
  const serialized = JSON.stringify(rules);
  if (rulesByProfile.has(profile) && rulesByProfile.get(profile) !== serialized) {
    throw new Error(`Accessibility profile ${profile} has conflicting rules for ${id}`);
  }
  rulesByProfile.set(profile, serialized);
  return `  ${JSON.stringify(id)}: { profile: ${JSON.stringify(profile)}, primitiveNotes: ${JSON.stringify(primitiveNotes)}, rules: PROFILE_RULES[${JSON.stringify(profile)}] },`;
});
const profileEntries = Array.from(rulesByProfile, ([profile, rules]) => {
  const object = JSON.stringify(JSON.parse(rules), null, 2).replaceAll("\n", "\n  ");
  return `  ${JSON.stringify(profile)}: ${object},`;
});
const output = `// Generated from uifn/catalog/generated/catalog.json. Do not edit by hand.\n` +
  `const PROFILE_RULES = {\n${profileEntries.join("\n")}\n} as const;\n\n` +
  `export const CATALOG_ACCESSIBILITY = {\n${accessibilityEntries.join("\n")}\n} as const;\n`;

if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== output) {
  fs.writeFileSync(outputPath, output);
}

console.log(JSON.stringify({
  ok: true,
  command: "generate:uifn-catalog-accessibility",
  primitiveCount: accessibilityEntries.length,
  outputPath,
}));
