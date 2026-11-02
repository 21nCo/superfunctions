import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { composeTaskSourceDigest, createComposeEnvironment, fingerprintComposeSource } from "../src/index.js";

// The digest reads the effective model of the Compose that runs the task, so these run against a supported Compose (2.24.4+).
const composeVersion = (() => {
  const result = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8", timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim().replace(/^v/, "").split(/[.+-]/).slice(0, 3).map(Number) : undefined;
})();
const composeAtLeast = (...minimum: number[]) => composeVersion !== undefined
  && minimum.reduce<number>((order, part, index) => order || Math.sign((composeVersion[index] ?? 0) - part), 0) >= 0;

async function withProject<T>(files: Record<string, string>, env: Record<string, string>,
  run: (spec: { adapter: "compose"; service: string; env: Record<string, string> }, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "devfn-task-digest-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }
    return await run({ adapter: "compose" as const, service: "setup", env }, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function digestOf(files: Record<string, string>, env: Record<string, string> = {}): Promise<string> {
  return await withProject(files, env, async (spec, root) => await composeTaskSourceDigest(spec, root, createComposeEnvironment(spec)));
}

describe.skipIf(!composeAtLeast(2, 24, 4))("Compose task source digest", () => {

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

  it("accepts and rejects a selected volume entry exactly as the startup fingerprint does", async () => {
    // Startup fingerprints a task's service before any task runs, so the revision reads the same model and fails closed where startup does.
    const forms: Array<[string, Record<string, string>]> = [
      ["data:/data", {}], ["${VOLUME:-data}:/data", {}], ["data:/x/${UNSET}", {}], ["data:/x/${API_TOKEN}", {}],
      ["data:/x/${API_TOKEN}", { API_TOKEN: "secret" }], ["${VOLUME:-data}:/x/${UNSET}:ro", {}], ["/x/${UNSET}", {}], ["/anonymous", {}],
    ];
    const outcome = async (run: () => Promise<string>) => await run().then(() => "accepted", () => "rejected");
    for (const [entry, env] of forms) {
      await withProject({ "compose.yaml": withVolume(entry) }, env, async (spec, root) => {
        const environment = createComposeEnvironment(spec);
        expect(await outcome(() => composeTaskSourceDigest(spec, root, environment)), entry)
          .toBe(await outcome(() => fingerprintComposeSource(spec, root, "instance", environment)));
      });
    }
    // An anonymous entry has no source, so it selects no declaration.
    const anonymous = await digestOf({ "compose.yaml": withVolume("/anonymous") });
    expect(await digestOf({ "compose.yaml": withVolume("/anonymous").replace("which: data", "which: changed") })).toBe(anonymous);
  }, 120_000);

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
    // A raw-format file (Compose 2.30+) counts line by line, its credential values masked too.
    if (!composeAtLeast(2, 30, 0)) return;
    const raw = async (content: string) => await digestOf({
      "compose.yaml": "services:\n  setup:\n    image: busybox\n    env_file:\n      - path: app.env\n        format: raw\n", "app.env": content });
    expect(await raw("app.mode=one\n")).not.toBe(await raw("app.mode=two\n"));
    expect(await raw("API_TOKEN=one\n")).toBe(await raw("API_TOKEN=two\n"));
  }, 60_000);

  it("digests resource declarations merged in Compose include order, not file load order", async () => {
    const setup = (extra = "") => `include:\n  - path: [a.yaml, b.yaml]\nservices:\n  setup:\n${extra}    image: busybox\n    volumes: [ "data:/data" ]\n    networks: [ net ]\n`;
    const layer = (volume: string, network = "") => `volumes:\n  data:\n    ${volume}\n${network ? `networks:\n  net:\n    ${network}\n` : ""}`;
    // A later file that redeclares only labels keeps the earlier name, so that name still counts.
    const partial = async (name: string, driver: string) => await digestOf({ "compose.yaml": setup(),
      "a.yaml": layer(`name: ${name}`, `driver_opts: { mode: ${driver} }`), "b.yaml": layer("labels: { which: b }", "labels: { which: b }") });
    const base = await partial("seed-one", "one");
    expect(await partial("seed-two", "one")).not.toBe(base);
    expect(await partial("seed-one", "two")).not.toBe(base);
    // The later file of the path list wins, even when an extends loads it before the earlier one.
    const ordered = async (a: string, b: string) => await digestOf({ "compose.yaml": setup("    extends: { file: b.yaml, service: tmpl }\n"),
      "a.yaml": layer(`name: ${a}`, "name: net"), "b.yaml": `services:\n  tmpl:\n    image: busybox\n${layer(`name: ${b}`, "name: net")}` });
    const effective = await ordered("from-a", "from-b");
    expect(await ordered("from-a", "edited-b")).not.toBe(effective);
    expect(await ordered("edited-a", "from-b")).toBe(effective);
  }, 60_000);

  it("digests each included resource as Compose resolves it in its own project directory, env file and merge tags", async () => {
    const setup = (include: string, use: string) => `include:\n  - ${include}\nservices:\n  setup:\n    image: busybox\n    ${use}\n`;
    // A root task consumes a config declared by an included model; the project directory selects the file it reads.
    const directory = async (dir: string) => await digestOf({ "compose.yaml": setup(`{ path: resources.yaml, project_directory: ${dir} }`, "configs: [ settings ]"),
      "resources.yaml": "configs:\n  settings:\n    file: ./settings.conf\n", "a/settings.conf": "mode=a\n", "b/settings.conf": "mode=b\n" });
    expect(await directory("./a")).not.toBe(await directory("./b"));
    // The included model's env_file resolves its declarations; a credential value there never counts.
    const scoped = async (env: string) => await digestOf({ "compose.yaml": setup("{ path: resources/compose.yaml, env_file: resources/project.env }", "volumes: [ \"data:/data\" ]"),
      "resources/compose.yaml": "volumes:\n  data:\n    name: ${SETUP_DATA:-seed-one}\n    labels: { token: \"${DB_PASSWORD:-none}\" }\n", "resources/project.env": env });
    const seeded = await scoped("SETUP_DATA=seed-one\nDB_PASSWORD=one\n");
    expect(await scoped("SETUP_DATA=seed-two\nDB_PASSWORD=one\n")).not.toBe(seeded);
    expect(await scoped("SETUP_DATA=seed-one\nDB_PASSWORD=two\n")).toBe(seeded);
    // A merge tag that replaces an earlier declaration either changes the effective resource or is rejected by Compose.
    const tagged = async (tag: string) => await digestOf({ "compose.yaml": setup("path: [ a.yaml, b.yaml ]", "volumes: [ \"data:/data\" ]"),
      "a.yaml": "volumes:\n  data:\n    name: seed-one\n", "b.yaml": `volumes:\n  data: ${tag}\n    labels: { which: b }\n` }).catch(() => "rejected");
    const merged = await tagged("");
    expect(merged).toMatch(/^[a-f0-9]{64}$/);
    for (const tag of ["!override", "!reset"]) expect(await tagged(tag), tag).not.toBe(merged);
  }, 60_000);

  it("masks a value an included scope derives from a credential, directly, through a nested include and through its project .env", async () => {
    const resources = "volumes:\n  data:\n    labels: { marker: \"${LABEL_VALUE}\", plain: \"${PLAIN_VALUE}\" }\n";
    const env = (password: string, plain = "one") => `DB_PASSWORD=${password}\nLABEL_VALUE=\${DB_PASSWORD}\nPLAIN_VALUE=${plain}\n`;
    const root = (include: string) => `include:\n  - ${include}\nservices:\n  setup:\n    image: busybox\n    volumes: [ "data:/data" ]\n`;
    const layouts: Array<[string, (value: string) => Record<string, string>]> = [
      ["include env_file", (value) => ({ "compose.yaml": root("{ path: resources/compose.yaml, env_file: resources/project.env }"),
        "resources/compose.yaml": resources, "resources/project.env": value })],
      ["nested include", (value) => ({ "compose.yaml": root("{ path: outer/compose.yaml }"),
        "outer/compose.yaml": "include:\n  - { path: inner/compose.yaml, env_file: inner/project.env }\n",
        "outer/inner/compose.yaml": resources, "outer/inner/project.env": value })],
      ["include project .env", (value) => ({ "compose.yaml": root("resources/compose.yaml"),
        "resources/compose.yaml": resources, "resources/.env": value })],
    ];
    for (const [layout, files] of layouts) {
      const before = await digestOf(files(env("one")));
      // Rotating the credential an alias carries never counts; a non-credential value in the same scope does.
      expect(await digestOf(files(env("two"))), layout).toBe(before);
      expect(await digestOf(files(env("one", "two"))), layout).not.toBe(before);
    }
  }, 120_000);

  it("masks a credential-derived value only in the scopes whose selected declarations use it, and rejects scopes that disagree", async () => {
    const include = (name: string) => `  - { path: ${name}/compose.yaml, env_file: ${name}/project.env }\n`;
    const volume = (name: string, field = "labels: { marker: \"${LABEL_VALUE}\" }") => `volumes:\n  ${name}:\n    ${field}\n`;
    const project = (uses: string[], envA: string, envB: string, rootVolumes = "", a = volume("data")) => ({
      "compose.yaml": `include:\n${include("a")}${include("b")}services:\n  setup:\n    image: busybox\n    volumes: ${JSON.stringify(uses)}\n${rootVolumes}`,
      "a/compose.yaml": a, "a/project.env": envA, "b/compose.yaml": volume("other"), "b/project.env": envB,
    });
    const derived = (password: string, alias = "${DB_PASSWORD}") => `DB_PASSWORD=${password}\nLABEL_VALUE=${alias}\n`;
    // A: the selected volume reads a plain value; another include derives the same name from a credential for a volume setup does not use.
    const before = await digestOf(project(["data:/data"], "LABEL_VALUE=one\n", derived("one")));
    expect(await digestOf(project(["data:/data"], "LABEL_VALUE=two\n", derived("one")))).not.toBe(before);
    // Rotating or rewriting that unrelated include's alias does not count.
    expect(await digestOf(project(["data:/data"], "LABEL_VALUE=one\n", derived("two")))).toBe(before);
    expect(await digestOf(project(["data:/data"], "LABEL_VALUE=one\n", derived("one", "x-${DB_PASSWORD}")))).toBe(before);
    // B: a root default counts although an unrelated include derives the name from a credential.
    const rootDefault = (value: string) => project(["data:/data"], "", derived("one"),
      volume("data", `name: \${LABEL_VALUE:-${value}}`), "services:\n  helper:\n    image: busybox\n");
    expect(await digestOf(rootDefault("seed-two"))).not.toBe(await digestOf(rootDefault("seed-one")));
    // Selected volumes whose scopes disagree on the name's provenance cannot be masked through one process environment.
    await expect(digestOf(project(["data:/data", "other:/other"], "LABEL_VALUE=one\n", derived("one")))).rejects.toThrow(/LABEL_VALUE/);
    // Where every scope that uses the name derives it from a credential, rotation still does not count.
    const both = (password: string) => project(["data:/data", "other:/other"], derived(password), derived(password));
    expect(await digestOf(both("two"))).toBe(await digestOf(both("one")));
  }, 180_000);

  it("attributes credential provenance only to the selected declarations that survive Compose's merge", async () => {
    const volume = (name: string, marker: string) => `volumes:\n  ${name}:\n    labels: { marker: "${marker}" }\n`;
    const project = (password: string, overridden = true, plain = "plain") => ({
      "compose.yaml": `include:\n  - { path: ${overridden ? "[ a/a.yaml, a/b.yaml ]" : "a/a.yaml"}, env_file: a/a.env }\n  - { path: c/c.yaml, env_file: c/c.env }\n`
        + "services:\n  setup:\n    image: busybox\n    volumes: [ \"data:/data\", \"other:/other\" ]\n",
      "a/a.yaml": volume("data", "${LABEL_VALUE}"), "a/b.yaml": volume("data", "literal"), "c/c.yaml": volume("other", "${LABEL_VALUE}"),
      "a/a.env": `DB_PASSWORD=${password}\nLABEL_VALUE=\${DB_PASSWORD}\n`, "c/c.env": `LABEL_VALUE=${plain}\n`,
    });
    // An overridden declaration's credential-derived name says nothing about the effective model: c's plain value counts, a's credential never does.
    const before = await digestOf(project("one"));
    expect(await digestOf(project("two"))).toBe(before);
    expect(await digestOf(project("one", true, "other"))).not.toBe(before);
    // Where a's declaration is effective, the selected volumes still disagree on the name's provenance.
    await expect(digestOf(project("one", false))).rejects.toThrow(/LABEL_VALUE/);
  }, 120_000);

  it("never digests a selected resource from a merge DevFn would make when Compose cannot show its uninterpolated model", async () => {
    // A docker whose config --no-interpolate fails, as supported Compose 2.24 does for a typed interpolated field such as cpus: ${CPUS}.
    const bin = await mkdtemp(path.join(tmpdir(), "devfn-no-interpolate-"));
    const docker = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(bin, "docker"), `#!/bin/sh\nfor arg; do [ "$arg" = --no-interpolate ] && { echo "unsupported field" >&2; exit 1; }; done\nexec "${docker}" "$@"\n`, { mode: 0o755 });
    const digest = async (files: Record<string, string>, forced: boolean) => await withProject(files, {}, async (spec, root) => await composeTaskSourceDigest(spec, root,
      createComposeEnvironment(spec, {}, forced ? { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } : process.env)));
    const merged = (password: string) => ({ "compose.yaml": "include:\n  - path: [ a.yaml, b.yaml ]\nservices:\n  setup:\n    image: busybox\n    volumes: [ \"data:/data\" ]\n",
      "a.yaml": "volumes:\n  data:\n    labels: { marker: \"${DB_PASSWORD}\" }\n", "b.yaml": "volumes:\n  data:\n    labels: { other: b }\n", ".env": `DB_PASSWORD=${password}\n` });
    const single = (password: string, which = "one") => ({ ".env": `DB_PASSWORD=${password}\n`,
      "compose.yaml": `services:\n  setup:\n    image: busybox\n    volumes: [ "data:/data" ]\nvolumes:\n  data:\n    labels: { marker: "\${DB_PASSWORD}", which: ${which} }\n` });
    try {
      // Compose's own model keeps a's credential label in the merged volume, and rotating the credential never counts.
      expect(await digest(merged("two"), false)).toBe(await digest(merged("one"), false));
      // Without that model, a volume several documents declare fails closed instead of digesting one document's declaration.
      await expect(digest(merged("one"), true)).rejects.toMatchObject({ code: "DEVFN_COMPOSE_START_FAILED", message: expect.stringContaining("volume data") });
      // A volume one document declares is that declaration: a rotation still never counts, and another value does.
      const base = await digest(single("one"), true);
      expect(await digest(single("two"), true)).toBe(base);
      expect(await digest(single("one", "two"), true)).not.toBe(base);
    } finally { await rm(bin, { recursive: true, force: true }); }
  }, 120_000);

  it("counts only the paths Compose resolves relative to the repository, and every other resource value as written", async () => {
    const yaml = (content: string, directory: string) => "services:\n  setup:\n    image: busybox\n    configs: [ settings ]\n    secrets: [ token ]\n    volumes: [ \"bound:/bound\" ]\n"
      + `configs:\n  settings:\n    content: ${content}\nsecrets:\n  token:\n    file: ./${directory}/token.txt\nvolumes:\n  bound:\n    driver_opts: { type: none, o: bind, device: ./${directory} }\n`;
    // Inline content is delivered as written, even when it spells a path inside the repository.
    const inline = async (content: (root: string) => string) => await withProject({ "data/token.txt": "t\n" }, {}, async (spec, root) => {
      await writeFile(path.join(root, "compose.yaml"), yaml(content(await realpath(root)), "data"));
      return await composeTaskSourceDigest(spec, root, createComposeEnvironment(spec));
    });
    expect(await inline((root) => `${root}/foo`)).not.toBe(await inline(() => "foo"));
    // A file or bind device under a directory whose name starts with .. is still inside the repository: each worktree gives one digest.
    const files = { "compose.yaml": yaml("foo", "..cache"), "..cache/token.txt": "t\n" };
    expect(await digestOf(files)).toBe(await digestOf(files));
  }, 120_000);
});
