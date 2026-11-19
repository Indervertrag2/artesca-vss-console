// @vitest-environment jsdom
//
// A purchase incident (issue #59) opens its own detail: the till record, each
// hint with the rule that discarded it, one clip per camera loaded only on
// click, and a chat link carrying the till record.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/incidents/ClipPlayer", () => ({
  ClipPlayer: ({ src }: { src: string }) => <div data-testid="clip" data-src={src} />,
}));

import { IncidentDetail } from "@/components/incidents/IncidentDetail";
import { judgePurchase, purchaseIncident, purchasesFromEvents } from "@/lib/purchase-judge";

const D = "2026-11-18T";
const [purchase] = purchasesFromEvents([
  { event: "item_scanned", ts: `${D}17:43:21Z`, payload: { session_id: 63, ean: "87126853" } },
  {
    event: "purchase_closed",
    ts: `${D}17:43:33Z`,
    payload: { session_id: 63, total_cents: 200, items: [{ ean: "87126853", name: "Cola 0,33 l Flasche", qty: 1 }] },
  },
]);
const verdict = judgePurchase(
  purchase,
  [
    { cameraId: "scanner-cam", start: `${D}17:43:08Z`, end: `${D}17:43:18Z`, text: "Yes - snack packet - placed next to the scanner." },
    { cameraId: "scanner-cam", start: `${D}17:43:15Z`, end: `${D}17:43:25Z`, text: "Yes - bottle moved over the scanner." },
  ],
  { scenarioId: "sco", scenarioName: "Self-checkout", sourceId: "till-1", cameras: [{ id: "overhead-cam" }, { id: "scanner-cam", view: "scanner glass" }] },
);
const INCIDENT = { ...purchaseIncident(verdict), clipKey: "", clipBucket: "", clipStatus: "pending" as const };

describe("purchase incident detail", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false }, { status: 404 })));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows why, loads a camera's clip only on click, and chats with the till record", async () => {
    await act(async () => { root.render(<IncidentDetail incident={INCIDENT} onClose={() => {}} />); });
    const text = document.body.textContent ?? "";
    // The title names the scenario and the time, not the till's purchase number.
    expect(text).not.toContain("purchase 63");
    expect(text).toContain("Cola 0,33 l Flasche");
    expect(text).toContain("not explained");
    expect(text).toContain("rule 1: scanned");
    expect(document.querySelectorAll('[data-testid="clip"]')).toHaveLength(0);

    const open = [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.includes("Open clip"));
    expect(open).toHaveLength(2);
    await act(async () => { open[1].click(); });
    const clips = document.querySelectorAll('[data-testid="clip"]');
    expect(clips).toHaveLength(1);
    expect(clips[0].getAttribute("data-src")).toBe(
      `/api/clips/scanner-cam/${encodeURIComponent(verdict.window!.start)}/index.m3u8?end=${encodeURIComponent(verdict.window!.end)}`,
    );

    const chat = [...document.body.querySelectorAll("a")].find((a) => a.textContent?.includes("Chat about this incident"))!;
    const q = new URL(chat.getAttribute("href")!, "http://console").searchParams;
    expect(q.get("sensor")).toBe("overhead-cam");
    expect(q.get("q")).toContain("Cola 0,33 l Flasche");
    expect(q.get("q")).toContain("overhead-cam, scanner-cam (scanner glass)");
    // A verdict from the live alerts says nothing about chunks.
    expect(text).not.toContain("Evidence:");
    expect(text).not.toContain("reported something");
  });

  it("says how a verdict judged from the recording was cut and what each camera reported (#60)", async () => {
    const recorded = {
      ...INCIDENT,
      ...purchaseIncident({ ...verdict, evidence: "recording", chunkS: 10, overlapS: 4, chunksAsked: { "overhead-cam": 10, "scanner-cam": 10 } }),
    };
    await act(async () => { root.render(<IncidentDetail incident={recorded} onClose={() => {}} />); });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Evidence: recording, 10 s chunks, 4 s overlap; 10 chunks per camera");
    expect(text).toContain("0 of 10 chunks reported something");
    expect(text).toContain("2 of 10 chunks reported something");
  });
});
