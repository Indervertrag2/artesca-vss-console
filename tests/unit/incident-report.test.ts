// generateIncidentReport: the deterministic fallback report (LLM unavailable)
// is never cached, so a later open retries the LLM instead of serving the
// degraded report as a normal one.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { reports } = vi.hoisted(() => ({ reports: new Map<string, unknown>() }));

vi.mock("@/lib/k8s", () => ({ appsV1: vi.fn(), resolveEnvValue: vi.fn() }));
vi.mock("@/lib/agent-config", () => ({
  AGENT_DEPLOYMENT_NAME: "vss-agent",
  collectAgentBehavior: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  saveIncidentReport: vi.fn((row: { sensorId: string; ts: string }) =>
    reports.set(`${row.sensorId}|${row.ts}`, row),
  ),
  loadIncidentReport: vi.fn((sensorId: string, ts: string) => reports.get(`${sensorId}|${ts}`) ?? null),
}));

import { collectAgentBehavior } from "@/lib/agent-config";
import { generateIncidentReport } from "@/lib/incident-report";

const INPUT = { sensorId: "cam-a", ts: "2026-01-01T12:00:00.000Z", raw: { info: { reasoning: "a person fell" } } };

beforeEach(() => {
  reports.clear();
  vi.mocked(collectAgentBehavior).mockReset();
});

describe("generateIncidentReport fallback", () => {
  it("does not serve a fallback report from the cache on the next open", async () => {
    vi.mocked(collectAgentBehavior).mockResolvedValue({ llm: { baseUrl: "" } } as never);

    const first = await generateIncidentReport(INPUT);
    expect(first.cached).toBe(false);
    expect(first.warnings?.join(" ")).toContain("deterministic fallback");

    const second = await generateIncidentReport(INPUT);
    expect(second.cached).toBe(false);
    expect(second.warnings?.join(" ")).toContain("deterministic fallback");
    expect(collectAgentBehavior).toHaveBeenCalledTimes(2);
  });
});
