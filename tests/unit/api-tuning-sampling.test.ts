import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// PATCH /api/tuning/sampling: the reconciler, where deployed, is the only
// writer of realtime rules; without it the route re-POSTs a rule only after
// its delete went through.

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    alertBridge: {
      realtimeUrl: "http://alert-bridge.test/api/v1/realtime",
      rulesConfigMap: "realtime-alert-rules",
      rulesNamespace: "vss",
      reconcilerDeployment: "vlm-stream-reconciler",
    },
  },
}));

vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn().mockResolvedValue({ value: {}, resourceVersion: "1" }),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/alert-bridge", () => ({
  deleteRealtimeRule: vi.fn(),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/k8s", () => ({
  deploymentExists: vi.fn(),
}));

import type { NextRequest } from "next/server";
import { deleteRealtimeRule } from "@/lib/helpers/alert-bridge";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { deploymentExists } from "@/lib/k8s";
import { PATCH } from "@/app/api/tuning/sampling/route";

const LIVE_RULES = [
  { id: "r1", sensor_name: "cam-1", alert_type: "fall", live_stream_url: "rtsp://src/cam-1" },
  { id: "r2", sensor_name: "cam-2", alert_type: "fall", live_stream_url: "rtsp://src/cam-2" },
];

let posts: Array<Record<string, unknown>>;

function patchRequest(): NextRequest {
  return new Request("http://localhost/api/tuning/sampling", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ framesPerChunk: 4, useFps: false, chunkDuration: 20 }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  posts = [];
  vi.mocked(deleteRealtimeRule).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(deploymentExists).mockReset();
  vi.mocked(patchConfigMapRawKey).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 201 });
      }
      return Response.json({ rules: LIVE_RULES });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PATCH /api/tuning/sampling", () => {
  it("with the reconciler deployed, writes the ConfigMap and deletes the live rules without posting any", async () => {
    vi.mocked(deploymentExists).mockResolvedValue(true);

    const res = await PATCH(patchRequest());

    expect(res.status).toBe(200);
    expect(patchConfigMapRawKey).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteRealtimeRule).mock.calls.map((c) => c[0]).sort()).toEqual(["r1", "r2"]);
    expect(posts).toEqual([]);
  });

  it("without the reconciler, does not re-post a rule whose delete failed", async () => {
    vi.mocked(deploymentExists).mockResolvedValue(false);
    vi.mocked(deleteRealtimeRule).mockImplementation(async (id: string) =>
      id === "r1" ? { ok: false, warning: "alert-bridge returned HTTP 500 on DELETE" } : { ok: true },
    );

    const res = await PATCH(patchRequest());
    const body = await res.json();

    expect(posts.map((p) => p.sensor_name)).toEqual(["cam-2"]);
    expect(posts[0].chunk_duration).toBe(20);
    expect(body.rulesReRegistered).toBe(1);
    expect(body.warnings.join(" ")).toContain("HTTP 500");
  });
});
