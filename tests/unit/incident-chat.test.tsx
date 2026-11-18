// @vitest-environment jsdom
//
// "Chat about this incident" (issue #54): the incident dialog links to
// /chat?sensor=&ts=&end=, and /chat scopes to the sensor — even one missing
// from /api/cameras — and prefills an editable question, then drops the params.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/MarkdownReport", () => ({ MarkdownReport: ({ markdown }: { markdown: string }) => <p>{markdown}</p> }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));

import ChatPage from "@/app/chat/page";
import { incidentChatHref, incidentChatPrefill, incidentScopeNote } from "@/lib/incident-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo = () => {};

const QUESTION =
  "Tell me about the incident on sensor camera-2 at 2026-01-02T03:04:05.000Z (until 2026-01-02T03:04:15.500Z). " +
  "Use the incident from rtvi_vlm_alert get_incidents for sensor camera-2 and run video understanding from " +
  "2026-01-02T03:03:35.000Z to 2026-01-02T03:04:45.500Z. " +
  "What happened, which products were involved, and was anything taken without being scanned?";

describe("incidentChatHref", () => {
  it("encodes sensor, ts and end", () => {
    expect(incidentChatHref("cam 1/a", "2026-01-02T03:04:05Z", "2026-01-02T03:04:15Z")).toBe(
      "/chat?sensor=cam%201%2Fa&ts=2026-01-02T03%3A04%3A05Z&end=2026-01-02T03%3A04%3A15Z",
    );
  });

  it("leaves end out when the incident has none", () => {
    expect(incidentChatHref("camera-1", "2026-01-02T03:04:05Z", undefined)).toBe(
      "/chat?sensor=camera-1&ts=2026-01-02T03%3A04%3A05Z",
    );
    expect(incidentChatHref("camera-1", "2026-01-02T03:04:05Z", 42)).not.toContain("end=");
  });
});

describe("incidentChatPrefill", () => {
  it("round-trips the href into a question with ISO timestamps and a ±30 s window", () => {
    const href = incidentChatHref("camera-2", "2026-01-02T03:04:05Z", "2026-01-02T03:04:15.5Z");
    expect(incidentChatPrefill(href.slice(href.indexOf("?")))).toEqual({
      sensor: "camera-2",
      question: QUESTION,
      from: "2026-01-02T03:03:35.000Z",
      to: "2026-01-02T03:04:45.500Z",
    });
  });

  it("windows around ts alone when end is missing or not after ts", () => {
    for (const q of ["sensor=camera-1&ts=2026-01-02T03:04:05Z", "sensor=camera-1&ts=2026-01-02T03:04:05Z&end=2026-01-02T03:04:00Z"]) {
      const p = incidentChatPrefill(q)!;
      expect(p.question).not.toContain("until");
      expect(p.question).toContain("from 2026-01-02T03:03:35.000Z to 2026-01-02T03:04:35.000Z");
    }
  });

  it("is null without a sensor or a valid ts", () => {
    expect(incidentChatPrefill("")).toBeNull();
    expect(incidentChatPrefill("ts=2026-01-02T03:04:05Z")).toBeNull();
    expect(incidentChatPrefill("sensor=camera-1&ts=garbage")).toBeNull();
  });
});

describe("/chat from an incident link", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("scopes to the incident recording, prefills the question and drops the params", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/chat"
        ? Response.json({ choices: [{ message: { content: "ok" } }] })
        : Response.json({ cameras: [{ id: "camera-1" }], available: false, voices: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", incidentChatHref("camera-2", "2026-01-02T03:04:05Z", "2026-01-02T03:04:15.5Z"));

    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<ChatPage />);
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(select.value).toBe("__incident__");
    const labels = [...select.options].map((o) => o.textContent ?? "");
    expect(labels[0]).toMatch(/^Incident recording: camera-2, /);
    // The live camera stays selectable, even one missing from /api/cameras.
    expect(labels).toContain("camera-2");
    expect(textarea.value).toBe(QUESTION);
    expect(window.location.search).toBe("");

    // The question names the recording window, so the scope adds no suffix.
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/chat") as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { messages: { content: string }[] };
    expect(body.messages.at(-1)!.content).toBe(QUESTION);
  });

  it("keeps follow-ups on the recording and never persists the incident scope", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/chat"
        ? Response.json({ choices: [{ message: { content: "ok" } }] })
        : Response.json({ cameras: [{ id: "camera-2" }], available: false, voices: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("nvidia-vss-chat-scope", "camera-1");
    window.history.replaceState(null, "", incidentChatHref("camera-2", "2026-01-02T03:04:05Z", "2026-01-02T03:04:15.5Z"));

    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<ChatPage />);
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, "What was scanned?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const call = fetchMock.mock.calls.find(([url]) => url === "/api/chat") as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { messages: { content: string }[] };
    const prefill = incidentChatPrefill("sensor=camera-2&ts=2026-01-02T03:04:05Z&end=2026-01-02T03:04:15.5Z")!;
    expect(body.messages.at(-1)!.content).toBe("What was scanned?" + incidentScopeNote(prefill));
    expect(localStorage.getItem("nvidia-vss-chat-scope")).toBe("camera-1");
  });
});
