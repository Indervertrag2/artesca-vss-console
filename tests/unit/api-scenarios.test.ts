import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { email: "op@test" } }) }));
vi.mock("@/lib/kiosk-server", () => ({ rejectIfKiosk: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/helpers/audit", () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/reconcile/context", () => ({ ReconcileContextError: class extends Error {}, makeReconcileContext: vi.fn() }));
vi.mock("@/lib/reconcile/scenarios", () => ({ reconcileScenarios: vi.fn().mockResolvedValue({ updated: true }) }));
vi.mock("@/lib/purchase-runner", () => ({
  purchaseStatus: vi.fn((ids: string[]) => Object.fromEntries(ids.map((id) => [id, { purchaseId: "63", incident: true }]))),
}));

// Stub modules with import-time side effects so the route imports cleanly.
vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({})),
  appsV1: vi.fn(() => ({})),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsScenariosGet: vi.fn().mockResolvedValue(null),
  gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/helpers/scenarios-apply", () => ({
  scenarioToGcsConfig: vi.fn((s: unknown) => s),
  applyScenariosLive: vi.fn().mockResolvedValue(undefined),
  gcsScenariosToCmPayload: vi.fn((scenarios: unknown[]) => ({ scenarios })),
  scenariosToYaml: vi.fn(() => ""),
}));
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    scenarios: {
      namespace: "alerts",
      configMap: "scenarios",
      yamlKey: "scenarios.yaml",
      alertWorkerDeployment: "alert-worker",
    },
  },
}));

import { auth } from "@/lib/auth";
import { makeReconcileContext } from "@/lib/reconcile/context";
import { reconcileScenarios } from "@/lib/reconcile/scenarios";
import { GET, PATCH } from "@/app/api/scenarios/route";

const SCEN = { id: "fall", name: "Fall", severity: "high" as const, channels: ["ui" as const], sensorFilter: "*", keywords: ["fall"], enabled: true };
function patchReq(body: unknown) {
  return new Request("http://localhost/api/scenarios", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => { vi.mocked(auth).mockResolvedValue({ user: { email: "op@test" } } as never); });

describe("scenarios route (k8s)", () => {
  it("GET returns Firestore scenarios mapped to the client shape", async () => {
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never,
      store: {
        readScenarios: vi.fn().mockResolvedValue([{ id: "fall", name: "Fall", severity: "high", channels: ["ui"], sensor_filter: "*", keywords: ["fall"], enabled: true }]),
        readCameras: vi.fn().mockResolvedValue([]),
        readSources: vi.fn().mockResolvedValue([]),
      } as never,
    } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios[0].id).toBe("fall");
    expect(body.scenarios[0].sensorFilter).toBe("*");
    expect(body.scenarios[0]).not.toHaveProperty("mode");
  });

  it("GET and PATCH carry a multi-camera scenario's fields, with its status and the pickable ids (#59)", async () => {
    const multi = {
      mode: "multi",
      cameras: [{ id: "overhead-cam", view: "above" }, { id: "scanner-cam" }],
      sources: [{ id: "till-1", role: "clock" }],
      rules: { matchToleranceS: 3, windowBeforeS: 30, windowAfterS: 20 },
    };
    const writeScenarios = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: { scenarios: {} } as never,
      store: {
        readScenarios: vi.fn().mockResolvedValue([{ id: "sco", name: "SCO", severity: "high", channels: ["ui"], sensor_filter: "*", keywords: [], enabled: true, ...multi }]),
        readCameras: vi.fn().mockResolvedValue([{ id: "overhead-cam" }, { id: "scanner-cam" }]),
        readSources: vi.fn().mockResolvedValue([{ id: "till-1" }]),
        writeScenarios,
      } as never,
    } as never);
    const body = await (await GET()).json();
    expect(body.scenarios[0]).toMatchObject(multi);
    expect(body.cameraIds).toEqual(["overhead-cam", "scanner-cam"]);
    expect(body.sourceIds).toEqual(["till-1"]);
    expect(body.purchaseStatus).toEqual({ sco: { purchaseId: "63", incident: true } });

    const res = await PATCH(patchReq({ scenarios: [{ ...SCEN, ...multi }, { ...SCEN, id: "plain", cameras: [{ id: "x" }] }] }));
    expect(res.status).toBe(200);
    const written = writeScenarios.mock.calls[0][1] as Record<string, unknown>[];
    expect(written[0]).toMatchObject(multi);
    // Without mode "multi" the multi fields are not stored.
    expect(written[1]).not.toHaveProperty("cameras");
    // A multi-camera scenario without evidence settings is stored as before (#60).
    expect(written[0]).not.toHaveProperty("evidence");
    expect(written[0]).not.toHaveProperty("chunkS");
  });

  it("GET and PATCH carry the evidence settings and a camera's crop, and PATCH says why a setting is refused (#60)", async () => {
    const recorded = {
      mode: "multi",
      cameras: [{ id: "overhead-cam", crop: { x: 400, y: 200, width: 1100, height: 620 } }, { id: "scanner-cam" }],
      sources: [{ id: "till-1", role: "clock" }],
      rules: { matchToleranceS: 3, windowBeforeS: 30, windowAfterS: 20 },
      evidence: "recording",
      chunkS: 8,
      overlapS: 3,
      framesPerSecond: 5,
      question: "Question: is a product carried away?",
      systemPrompt: "You watch a self-checkout.",
    };
    const writeScenarios = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: { scenarios: {} } as never,
      store: {
        readScenarios: vi.fn().mockResolvedValue([{ id: "sco", name: "SCO", severity: "high", channels: ["ui"], sensor_filter: "*", keywords: [], enabled: true, ...recorded }]),
        readCameras: vi.fn().mockResolvedValue([]),
        readSources: vi.fn().mockResolvedValue([]),
        writeScenarios,
      } as never,
    } as never);
    expect((await (await GET()).json()).scenarios[0]).toMatchObject(recorded);

    expect((await PATCH(patchReq({ scenarios: [{ ...SCEN, ...recorded }] }))).status).toBe(200);
    expect((writeScenarios.mock.calls[0][1] as Record<string, unknown>[])[0]).toMatchObject(recorded);

    // 16 s x 4 frames per second is more than the model takes per request.
    const res = await PATCH(patchReq({ scenarios: [{ ...SCEN, ...recorded, chunkS: 16, framesPerSecond: 4 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Validation failed: scenarios\.0\.evidence: 16 s chunks at 4 frames per second are 64 frames per request; the model takes at most 60/);
    const overlap = await PATCH(patchReq({ scenarios: [{ ...SCEN, ...recorded, overlapS: 8 }] }));
    expect((await overlap.json()).error).toMatch(/Overlap must be a whole number of seconds from 0 to 7/);
    expect(writeScenarios).toHaveBeenCalledTimes(1);
  });

  it("PATCH writes Firestore then applies write-through", async () => {
    const writeScenarios = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: { scenarios: {} } as never, store: { writeScenarios } as never,
    } as never);
    const res = await PATCH(patchReq({ scenarios: [SCEN] }));
    expect(res.status).toBe(200);
    expect(writeScenarios).toHaveBeenCalledWith("inst-1", expect.arrayContaining([expect.objectContaining({ id: "fall", sensor_filter: "*" })]), "op@test");
    expect(reconcileScenarios).toHaveBeenCalled();
  });

  it("GET returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET returns degraded response when config store unavailable", async () => {
    vi.mocked(makeReconcileContext).mockRejectedValue(new Error("Firestore init failed: creds missing"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios).toEqual([]);
    expect(body.warnings).toBeDefined();
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("PATCH returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(patchReq({ scenarios: [SCEN] }));
    expect(res.status).toBe(401);
  });

  it("PATCH returns 400 on invalid body", async () => {
    const res = await PATCH(patchReq({ scenarios: [] }));
    expect(res.status).toBe(400);
  });

  it("PATCH returns 502 when config store write fails", async () => {
    vi.mocked(makeReconcileContext).mockRejectedValue(new Error("Firestore unavailable"));
    const res = await PATCH(patchReq({ scenarios: [SCEN] }));
    expect(res.status).toBe(502);
  });
});
