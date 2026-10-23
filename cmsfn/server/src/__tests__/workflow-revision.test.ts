import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createCmsfnServer } from "../index.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function fixture(run: (context: {
  post: (path: string, body: object) => Promise<unknown>;
  publications: Array<Record<string, unknown>>;
}) => Promise<void>, revision: unknown = "approved-r1", changed = true) {
  const publications: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    res.setHeader("Content-Type", "application/json");
    const id = String(body.id).replace(/^drafts\./, "");
    if (req.url === "/contentfn/docs/get") {
      res.end(JSON.stringify({ ok: true, result: { _id: `drafts.${id}`, _type: "post", _rev: revision, _cms: { state: "approved" } } }));
    } else if (req.url === "/contentfn/docs/publish") {
      publications.push(body);
      // An editor changes the first draft after CmsFn's gate has read it.
      const currentRev = changed && id === "a" ? "unapproved-r2" : "approved-r1";
      if (body.ifRev !== undefined && body.ifRev !== currentRev) {
        res.end(JSON.stringify({ ok: false, error: { code: "REV_CONFLICT", message: "Draft changed", details: { expectedRev: body.ifRev, actualRev: currentRev } } }));
      } else {
        res.end(JSON.stringify({ ok: true, result: { _id: id, _type: "post", _rev: "published-r3" } }));
      }
    } else { res.statusCode = 404; res.end(); }
  });
  const db = memoryAdapter();
  const cms = createCmsfnServer({
    contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: "prod" }],
    desk: { kind: "divider" }, auth: { kind: "custom" }, db,
    getRolesForSubject: async () => [{ id: "editor", name: "Editor", rules: [{ datasets: ["prod"], types: "*", actions: ["doc.publish", "release.manage"] }] }],
  });
  try {
    const base = await listen(cms);
    await run({ publications, post: async (path, body) => {
      const response = await fetch(`${base}/cmsfn/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json();
    } });
  } finally { await close(cms); await close(upstream); await db.close(); }
}

it("binds a single publish to the workflow-checked revision and retains conflict details", async () => fixture(async ({ post, publications }) => {
  expect(await post("publish", { dataset: "prod", id: "a" })).toMatchObject({ ok: false, error: { code: "CONFLICT", details: { expectedRev: "approved-r1", actualRev: "unapproved-r2", upstreamCode: "REV_CONFLICT" } } });
  expect(publications).toEqual([{ dataset: "prod", id: "a", ifRev: "approved-r1" }]);
}));

it("publishes an unchanged approved revision including a draft-prefixed ID", async () => fixture(async ({ post, publications }) => {
  expect(await post("publish", { dataset: "prod", id: "drafts.a" })).toMatchObject({ ok: true, result: { _id: "a" } });
  expect(publications).toEqual([{ dataset: "prod", id: "drafts.a", ifRev: "approved-r1" }]);
}, "approved-r1", false));

it("reports a changed release document as a conflict and continues in sorted order", async () => fixture(async ({ post, publications }) => {
  const created = await post("releases/create", { dataset: "prod", name: "Launch" });
  expect(created).toMatchObject({ ok: true });
  if (!created || typeof created !== "object" || !("result" in created)) throw new Error("Missing release");
  const result = created.result;
  if (!result || typeof result !== "object" || !("releaseId" in result) || typeof result.releaseId !== "string") throw new Error("Missing release ID");
  const { releaseId } = result;
  for (const docId of ["z", "a"]) expect(await post("releases/add", { dataset: "prod", releaseId, docId })).toMatchObject({ ok: true });
  expect(await post("releases/publish", { dataset: "prod", releaseId })).toEqual({ ok: true, result: { releaseId, published: ["z"], failures: [{ docId: "a", code: "CONFLICT", message: "Draft changed" }] } });
  expect(publications).toEqual(["a", "z"].map(id => ({ dataset: "prod", id, ifRev: "approved-r1" })));
}));

for (const revision of [undefined, "", "   ", 42]) {
  it(`does not publish a draft with unusable revision ${JSON.stringify(revision)}`, async () => fixture(async ({ post, publications }) => {
    expect(await post("publish", { dataset: "prod", id: "a" })).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
    const created = await post("releases/create", { dataset: "prod", name: "Malformed draft" });
    if (!created || typeof created !== "object" || !("result" in created)) throw new Error("Missing release");
    const result = created.result;
    if (!result || typeof result !== "object" || !("releaseId" in result) || typeof result.releaseId !== "string") throw new Error("Missing release ID");
    const { releaseId } = result;
    expect(await post("releases/add", { dataset: "prod", releaseId, docId: "a" })).toMatchObject({ ok: true });
    expect(await post("releases/publish", { dataset: "prod", releaseId })).toMatchObject({ ok: true, result: { published: [], failures: [{ docId: "a", code: "CONTENTFN_UNAVAILABLE" }] } });
    expect(publications).toEqual([]);
  }, revision === undefined ? Symbol("missing revision") : revision));
}
