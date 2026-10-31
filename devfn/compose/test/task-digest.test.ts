import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { composeTaskSourceDigest, createComposeEnvironment } from "../src/index.js";

async function digestOf(files: Record<string, string>, env: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "devfn-task-digest-"));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
    const spec = { adapter: "compose" as const, service: "setup", env };
    return await composeTaskSourceDigest(spec, root, createComposeEnvironment(spec));
  } finally { await rm(root, { recursive: true, force: true }); }
}

const withVolume = (entry: string) => `services:\n  setup:\n    image: busybox\n    volumes:\n      - "${entry}"\nvolumes:\n  data:\n    labels: { which: data }\n  other:\n    labels: { which: other }\n`;

it("selects the volume an interpolated short volume entry names, defaults included", async () => {
  const plain = await digestOf({ "compose.yaml": withVolume("data:/data") });
  expect(plain).toMatch(/^[a-f0-9]{64}$/);
  // Each form selects the declared volume Compose selects, so a change to that declaration changes the revision.
  const forms: Array<[string, Record<string, string>]> = [
    ["${VOLUME:-data}:/data", {}], ["${VOLUME:-other}:/data", { VOLUME: "data" }],
    ["${VOLUME:?required}:/data", { VOLUME: "data" }], ["${FLAG:+data}:/data", { FLAG: "1" }],
  ];
  for (const [entry, env] of forms) {
    const before = await digestOf({ "compose.yaml": withVolume(entry) }, env);
    const after = await digestOf({ "compose.yaml": withVolume(entry).replace("which: data", "which: changed") }, env);
    const unrelated = await digestOf({ "compose.yaml": withVolume(entry).replace("which: other", "which: changed") }, env);
    expect(before, entry).not.toBe(after);
    expect(before, entry).toBe(unrelated);
  }
  // A required variable left unset still fails before anything starts.
  await expect(digestOf({ "compose.yaml": withVolume("${VOLUME:?required}:/data") })).rejects.toThrow(/resources of setup/);
}, 60_000);

it("selects a short volume entry by its source alone, whatever its target interpolates", async () => {
  // Compose substitutes an empty string for an unset target reference, and a
  // credential-named target never selects a declaration.
  const forms: Array<[string, Record<string, string>]> = [
    ["data:/x/${UNSET}", {}], ["data:/x/${API_TOKEN}", {}], ["data:/x/${API_TOKEN}", { API_TOKEN: "secret" }],
    ["${VOLUME:-data}:/x/${UNSET}:ro", {}],
  ];
  for (const [entry, env] of forms) {
    const before = await digestOf({ "compose.yaml": withVolume(entry) }, env);
    const after = await digestOf({ "compose.yaml": withVolume(entry).replace("which: data", "which: changed") }, env);
    const unrelated = await digestOf({ "compose.yaml": withVolume(entry).replace("which: other", "which: changed") }, env);
    expect(before, entry).not.toBe(after);
    expect(before, entry).toBe(unrelated);
  }
}, 60_000);

it("digests the resource declarations of the project model, not those of an extends-only file", async () => {
  const root = (volume: string, network: string) => "services:\n  setup:\n    extends: { file: base.yaml, service: base }\n"
    + `    volumes: [ "data:/data" ]\n    networks: [ net ]\nvolumes:\n  data:\n    name: ${volume}\nnetworks:\n  net:\n    name: ${network}\n`;
  const base = (volume: string, network: string) => "services:\n  base:\n    image: busybox\n"
    + `volumes:\n  data:\n    name: ${volume}\nnetworks:\n  net:\n    name: ${network}\n`;
  const digest = async (rootFile: string, baseFile: string) => await digestOf({ "compose.yaml": rootFile, "base.yaml": baseFile });
  const before = await digest(root("actual-one", "net-one"), base("unused", "unused"));
  // The root declarations are the effective ones, so editing either changes the revision.
  expect(await digest(root("actual-two", "net-one"), base("unused", "unused"))).not.toBe(before);
  expect(await digest(root("actual-one", "net-two"), base("unused", "unused"))).not.toBe(before);
  // Compose imports only the service through extends, so the base declarations do not count.
  expect(await digest(root("actual-one", "net-one"), base("ignored", "ignored"))).toBe(before);
}, 60_000);

it("counts every env_file declaration Compose passes to the container, masking only credential values", async () => {
  const digest = async (content: string) => await digestOf({
    "compose.yaml": "services:\n  setup:\n    image: busybox\n    env_file: app.env\n", "app.env": content });
  for (const [one, two] of [["app.mode=one\n", "app.mode=two\n"], ["app-mode=one\n", "app-mode=two\n"], ["MODE\n", "OTHER_MODE\n"], ["MODE=one\n", "MODE=two\n"]]) {
    expect(await digest(one), `${one} vs ${two}`).not.toBe(await digest(two));
  }
  // Credential values stay out of the digest; their names still count.
  expect(await digest("API_TOKEN=one\n")).toBe(await digest("API_TOKEN=two\n"));
  expect(await digest("API_TOKEN=one\n")).not.toBe(await digest("OTHER_TOKEN=one\n"));
  // Formatting and comments do not count.
  expect(await digest("MODE=one\n")).toBe(await digest("# comment\nMODE=one # trailing\n"));
  // A raw-format file counts line by line, its credential values masked too.
  const raw = async (content: string) => await digestOf({
    "compose.yaml": "services:\n  setup:\n    image: busybox\n    env_file:\n      - path: app.env\n        format: raw\n", "app.env": content });
  expect(await raw("app.mode=one\n")).not.toBe(await raw("app.mode=two\n"));
  expect(await raw("API_TOKEN=one\n")).toBe(await raw("API_TOKEN=two\n"));
}, 60_000);
