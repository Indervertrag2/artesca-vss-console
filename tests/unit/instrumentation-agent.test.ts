// console/tests/unit/instrumentation-agent.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const startReconcileLoop = vi.fn(async () => {});
vi.mock("@/lib/reconcile-agent", () => ({ startReconcileLoop }));
// The source poller would start a real 2.5 s interval against the config store.
vi.mock("@/lib/source-poll", () => ({ startSourcePoller: vi.fn() }));
// So would the purchase runner (10 s), reading the SQLite event log.
const startPurchaseRunner = vi.fn();
vi.mock("@/lib/purchase-runner", () => ({ startPurchaseRunner }));
vi.mock("@/lib/source-events", () => ({ listSourceEvents: vi.fn() }));

describe("instrumentation register() — agent mode", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    // register() guards on globalThis.__started (survives HMR); reset it so each
    // test gets a fresh register() execution.
    delete (globalThis as unknown as { __started?: boolean }).__started;
    startReconcileLoop.mockClear();
    process.env.NEXT_RUNTIME = "nodejs";
  });
  afterEach(() => { process.env = { ...OLD }; });

  it("RECONCILE_AGENT=1 starts the loop and skips the camera watcher", async () => {
    process.env.RECONCILE_AGENT = "1";
    process.env.VSS_INSTANCE_NAME = "inst-1";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalledTimes(1);
  });

  it("without RECONCILE_AGENT, k8s mode runs the reconcile loop (not the camera watcher)", async () => {
    delete process.env.RECONCILE_AGENT;
    process.env.VSS_INSTANCE_NAME = "inst-1";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalledTimes(1);
    // The purchase runner runs here, in the console pod that owns the SQLite file (#59).
    expect(startPurchaseRunner).toHaveBeenCalledWith("inst-1", expect.any(Function));
  });
});
