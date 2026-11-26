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
const isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const rulesByProfile = new Map();
const accessibilityEntries = catalog.primitives.map(({ id, accessibility }) => {
  const { profile, primitiveNotes, rules } = accessibility;
  if (typeof profile !== "string" || typeof rules?.nativeSemantics !== "string" ||
      !isStringArray(rules.keyboard?.keys) || !isStringArray(rules.focus) || !isStringArray(rules.wcag)) {
    throw new Error(`Accessibility summary fields are invalid for ${id}`);
  }
  const existing = rulesByProfile.get(profile);
  if (existing && JSON.stringify(existing) !== JSON.stringify(rules)) {
    throw new Error(`Accessibility profile ${profile} has conflicting rules for ${id}`);
  }
  rulesByProfile.set(profile, rules);
  return [id, { profile, primitiveNotes }];
});
const payload = JSON.stringify({
  rulesByProfile: Object.fromEntries(rulesByProfile),
  primitives: Object.fromEntries(accessibilityEntries),
}, null, 2)
  .replaceAll("\\", "\\\\")
  .replaceAll("`", "\\`")
  .replaceAll("${", "\\${");
const output = `// Generated from uifn/catalog/generated/catalog.json. Do not edit by hand.\n` +
  `export const catalogAccessibilityJson: string = \`\n${payload}\n\`;\n`;

if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== output) {
  fs.writeFileSync(outputPath, output);
}

console.log(JSON.stringify({
  ok: true,
  command: "generate:uifn-catalog-accessibility",
  primitiveCount: accessibilityEntries.length,
  outputPath,
}));
