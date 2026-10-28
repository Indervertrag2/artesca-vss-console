// The AI Factory switch's restore of an emptied config store: fill each empty list from the copy,
// never overwrite a list that holds anything. The file store, the pure plan and the two routes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/helpers/audit", () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/kiosk-server", () => ({ rejectIfKiosk: vi.fn(async () => null) }));
const ctxRef: { store: unknown; instance: string } = { store: null, instance: "showroom" };
vi.mock("@/lib/reconcile/context", () => ({
  makeReconcileContext: vi.fn(async () => ctxRef),
  ReconcileContextError: class extends Error {},
}));

import { auth } from "@/lib/auth";
import { FileConfigStore, configFilePath, CONFIG_SCHEMA } from "@/lib/config-store/file";
import { parseFillSource, planFill, FillError } from "@/lib/config-store/fill";
import { GET as exportGET } from "@/app/api/config-store/export/route";
import { POST as restorePOST } from "@/app/api/config-store/restore/route";
import { NextRequest } from "next/server";

const CAMS = [0, 1, 2, 3].map((i) => ({ id: `cam${i}`, rtspUrl: `rtsp://10.0.0.${i}:8554/video0`, enabled: true }));
const SCEN = [{ id: "s1", name: "Theft", severity: "high", channels: ["ui"], sensor_filter: "*", keywords: ["x"], enabled: true }];
const SETS = [{ id: "p1", name: "Retail", text: "Watch the shelves" }];
const COPY = { schema: CONFIG_SCHEMA, instance: "showroom", cameras: CAMS, scenarios: SCEN, promptSets: SETS, activePromptId: "p1" };

let dir: string;
let store: FileConfigStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cfg-restore-"));
  store = new FileConfigStore(dir);
  ctxRef.store = store;
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown, type = "application/json") =>
  restorePOST(new NextRequest("http://console/api/config-store/restore", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) }));

describe("planFill", () => {
  const src = parseFillSource(COPY, "showroom");
  it("fills every empty list and sets the active prompt it brings", () => {
    const r = planFill({ cameras: [], scenarios: [], promptSets: [] }, src);
    expect([r.restored, r.kept, r.activePromptId]).toEqual([["cameras", "scenarios", "promptSets"], [], true]);
  });
  it("keeps a list that holds anything, whatever the copy says", () => {
    const r = planFill({ cameras: [{ id: "mine" }], scenarios: [], promptSets: [{ id: "p9" }], activePromptId: "p9" }, src);
    expect([r.restored, r.kept, r.activePromptId, r.next.cameras, r.next.promptSets]).toEqual([["scenarios"], ["cameras", "promptSets"], false, undefined, undefined]);
  });
  it("an empty list in the copy restores nothing for it", () => {
    const r = planFill({ cameras: [], scenarios: [], promptSets: [] }, parseFillSource({ cameras: CAMS }, "showroom"));
    expect(r.restored).toEqual(["cameras"]);
  });
});

describe("parseFillSource", () => {
  it("refuses another instance's copy, an unknown field, a duplicate id and an entry with no id", () => {
    expect(() => parseFillSource({ ...COPY, instance: "other" }, "showroom")).toThrow(FillError);
    expect(() => parseFillSource({ ...COPY, extra: 1 }, "showroom")).toThrow(/unknown field/);
    expect(() => parseFillSource({ cameras: [CAMS[0], CAMS[0]] }, "showroom")).toThrow(/twice/);
    expect(() => parseFillSource({ cameras: [{ rtspUrl: "x" }] }, "showroom")).toThrow(/no string id/);
    expect(() => parseFillSource({ schema: "other" }, "showroom")).toThrow(/schema/);
  });
});

describe("FileConfigStore.fillEmpty", () => {
  it("restores an emptied store from the copy, all four cameras", async () => {
    await store.writeCameras("showroom", [], "test");
    const r = await store.fillEmpty("showroom", parseFillSource(COPY, "showroom"), "test");
    expect(r.restored).toEqual(["cameras", "scenarios", "promptSets"]);
    expect((await store.readCameras("showroom")).map((c) => c.id)).toEqual(["cam0", "cam1", "cam2", "cam3"]);
    expect(await store.readActivePromptId("showroom")).toBe("p1");
  });
  it("never overwrites a non-empty list, and writes nothing when nothing is empty", async () => {
    const mine = [{ id: "mine", rtspUrl: "rtsp://keep" }];
    await store.writeCameras("showroom", mine as never, "test");
    await store.writeScenarios("showroom", SCEN as never, "test");
    await store.upsertPromptSet("showroom", SETS[0], "test");
    const before = await readFile(configFilePath("showroom", dir), "utf8");
    const r = await store.fillEmpty("showroom", parseFillSource(COPY, "showroom"), "test");
    expect([r.restored, r.kept]).toEqual([[], ["cameras", "scenarios", "promptSets"]]);
    expect(await readFile(configFilePath("showroom", dir), "utf8")).toBe(before);
  });
  it("fills the empty scenarios beside kept cameras", async () => {
    await store.writeCameras("showroom", [{ id: "mine" }] as never, "test");
    const r = await store.fillEmpty("showroom", parseFillSource(COPY, "showroom"), "test");
    expect([r.restored, r.kept]).toEqual([["scenarios", "promptSets"], ["cameras"]]);
    expect((await store.readCameras("showroom")).map((c) => c.id)).toEqual(["mine"]);
    expect((await store.readScenarios("showroom")).map((s) => s.id)).toEqual(["s1"]);
  });
  it("refuses a file that does not parse rather than reading it as empty", async () => {
    await mkdir(path.join(dir), { recursive: true });
    await writeFile(configFilePath("showroom", dir), "cameras: [unclosed\n");
    await expect(store.fillEmpty("showroom", parseFillSource(COPY, "showroom"), "test")).rejects.toThrow();
  });
});

describe("GET /api/config-store/export and POST /api/config-store/restore", () => {
  it("export answers the store's lists; restore takes that body back into an emptied store", async () => {
    await store.fillEmpty("showroom", parseFillSource(COPY, "showroom"), "seed");
    const exported = await (await exportGET()).json();
    expect(exported).toMatchObject({ schema: CONFIG_SCHEMA, instance: "showroom", activePromptId: "p1" });
    expect(exported.cameras).toHaveLength(4);

    await store.writeCameras("showroom", [], "wipe");
    await store.writeScenarios("showroom", [], "wipe");
    const res = await post(exported);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: ["cameras", "scenarios"], kept: ["promptSets"], activePromptId: false });
    expect((await store.readCameras("showroom")).map((c) => c.id)).toEqual(["cam0", "cam1", "cam2", "cam3"]);
  });
  it("restore keeps a non-empty store as it is", async () => {
    await store.writeCameras("showroom", [{ id: "mine" }] as never, "test");
    const res = await post({ cameras: CAMS });
    expect(await res.json()).toEqual({ restored: [], kept: ["cameras"], activePromptId: false });
    expect((await store.readCameras("showroom")).map((c) => c.id)).toEqual(["mine"]);
  });
  it("export answers 503, never empty lists, when the store cannot be read", async () => {
    await writeFile(configFilePath("showroom", dir), "cameras: [unclosed\n");
    expect((await exportGET()).status).toBe(503);
  });
  it("401 without a session, 415 without JSON, 400 on a bad body, 501 on another backend", async () => {
    expect((await post(COPY, "text/plain")).status).toBe(415);
    expect((await post({ cameras: "x" })).status).toBe(400);
    ctxRef.store = { readCameras: async () => [] };
    expect((await post(COPY)).status).toBe(501);
    ctxRef.store = store;
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await post(COPY)).status).toBe(401);
    expect((await exportGET()).status).toBe(401);
  });
});
