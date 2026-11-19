"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MessageSquare, Video } from "lucide-react";
import { incidentChatHref, incidentClipUrl } from "@/lib/incident-chat";
import { money, purchaseChatQuestion, type HintOutcome, type PurchaseVerdict } from "@/lib/purchase-judge";
import { ClipPlayer } from "./ClipPlayer";
import type { Incident } from "@/lib/types";

// The detail of a purchase incident (multi-camera scenario): one clip per camera,
// loaded only on request and played together, then the till record and every
// camera hint with the rule that discarded it or why it remained, and a chat that
// starts from the till data. A verdict judged from the recording also says how it
// was cut and asked.

const OUTCOME: Record<HintOutcome, { label: string; cls: string }> = {
  remains: { label: "not explained", cls: "bg-red-50 text-red-700 border-red-200" },
  scanned: { label: "rule 1: scanned", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paid: { label: "rule 2: paid", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  negative: { label: "answer no", cls: "bg-muted text-muted-foreground border-border" },
};

const time = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Clips further apart than this are pulled together; below it a seek would only stutter. */
const SYNC_SLACK_S = 0.3;
/** Up to this many cameras, the clips of an incident are open when it is opened. */
const OPEN_AT_ONCE = 4;

interface Props {
  incident: Incident;
  verdict: PurchaseVerdict;
  onClose: () => void;
}

export function PurchaseIncidentDetail({ incident, verdict: v, onClose }: Props) {
  // The clips are open from the start, so they can be watched together at once.
  // A scenario with many cameras opens none: every clip is a download of its own.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(v.cameras.length <= OPEN_AT_ONCE ? v.cameras.map((c) => c.id) : []),
  );
  // State, not a ref: the dialog mounts its content after this component's first
  // effect, and the listeners below have to attach when the element arrives.
  const [clips, setClips] = useState<HTMLDivElement | null>(null);
  const w = v.window ?? { start: v.closedAt, end: v.closedAt };
  // Only on a verdict judged from the recording: chunks put to the model, per camera.
  const asked = v.evidence === "recording" ? (v.chunksAsked ?? {}) : null;
  const perCamera = [...new Set(Object.values(asked ?? {}))].join(" or ") || "0";
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = v.cameras.length > 0 && v.cameras.every((c) => open.has(c.id));

  // Every clip covers the same purchase window, so the open ones run as one: play,
  // pause and seek on any of them carry over to the others, at the same second.
  // Media events do not bubble; they are caught on the way down, so a clip that is
  // opened later needs no listener of its own.
  useEffect(() => {
    const box = clips;
    if (!box) return;
    const others = (from: EventTarget | null) =>
      [...box.querySelectorAll("video")].filter((x) => x !== from);
    const align = (from: HTMLVideoElement, to: HTMLVideoElement) => {
      if (Math.abs(to.currentTime - from.currentTime) > SYNC_SLACK_S) to.currentTime = from.currentTime;
    };
    const onPlay = (e: Event) => {
      const from = e.target as HTMLVideoElement;
      for (const o of others(from)) {
        align(from, o);
        if (o.paused) void o.play().catch(() => undefined);
      }
    };
    const onPause = (e: Event) => {
      const from = e.target as HTMLVideoElement;
      // The end of the shorter clip is a pause too; it must not stop the longer one.
      if (from.ended) return;
      for (const o of others(from)) if (!o.paused) o.pause();
    };
    const onSeeked = (e: Event) => {
      const from = e.target as HTMLVideoElement;
      for (const o of others(from)) align(from, o);
    };
    box.addEventListener("play", onPlay, true);
    box.addEventListener("pause", onPause, true);
    box.addEventListener("seeked", onSeeked, true);
    return () => {
      box.removeEventListener("play", onPlay, true);
      box.removeEventListener("pause", onPause, true);
      box.removeEventListener("seeked", onSeeked, true);
    };
  }, [clips]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-red-700">
              {incident.severity}
            </span>
            <span>{v.scenarioName}</span>
            <span className="text-xs text-muted-foreground">{new Date(v.closedAt).toLocaleString()}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-5 text-sm">
          <p>{v.summary}</p>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Cameras</h3>
              {v.cameras.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  onClick={() => setOpen(allOpen ? new Set() : new Set(v.cameras.map((c) => c.id)))}
                >
                  <Video className="mr-1.5 h-3 w-3" />
                  {allOpen ? "Close all clips" : "Open all clips"}
                </Button>
              )}
            </div>
            {/* Side by side from two cameras on: the clips are watched together. */}
            <div ref={setClips} className={v.cameras.length > 1 ? "grid gap-2 md:grid-cols-2" : "space-y-2"}>
              {v.cameras.map((c) => (
                <div key={c.id} className="min-w-0 rounded border border-border p-2">
                  {/* The text wraps, the button never does: every camera's button sits in the same right-hand column. */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 pt-1.5 text-xs">
                      <span className="font-mono">{c.id}</span>
                      {c.view && <span className="ml-2 text-muted-foreground">{c.view}</span>}
                      <span className="ml-2">{v.camerasSaw.includes(c.id) ? "saw it" : "no unexplained hint"}</span>
                      {asked && (
                        <span className="ml-2 text-muted-foreground">
                          {`${v.hints.filter((h) => h.cameraId === c.id && h.outcome !== "negative").length} of ${asked[c.id] ?? 0} chunks reported something`}
                        </span>
                      )}
                    </div>
                    <Button type="button" variant="outline" size="sm" className="h-7 w-24 shrink-0 px-2 text-[11px]" onClick={() => toggle(c.id)}>
                      <Video className="mr-1.5 h-3 w-3" />
                      {open.has(c.id) ? "Close clip" : "Open clip"}
                    </Button>
                  </div>
                  {open.has(c.id) && (
                    <div className="mt-2">
                      <ClipPlayer
                        src={incidentClipUrl(c.id, w.start, w.end)}
                        clipStatus={incident.clipStatus}
                        fallbackMeta={{
                          ts: w.start,
                          sensorId: c.id,
                          severity: incident.severity,
                          summary: v.summary,
                          scenarioName: v.scenarioName,
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <Button asChild variant="outline" size="sm" className="h-7 px-2 text-[11px]">
            <Link href={incidentChatHref(incident.sensorId, w.start, w.end, purchaseChatQuestion(v))}>
              <MessageSquare className="mr-1.5 h-3 w-3" />
              Chat about this incident
            </Link>
          </Button>

          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Why</h3>
            {asked && (
              <p className="text-xs text-muted-foreground">
                {`Evidence: recording, ${v.chunkS} s chunks, ${v.overlapS} s overlap; ${perCamera} chunk${perCamera === "1" ? "" : "s"} per camera`}
              </p>
            )}

            <div className="rounded border border-border p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                Till <span className="font-mono">{v.sourceId}</span>
                {v.startedAt ? `: started ${time(v.startedAt)}, ` : ": "}
                {v.status} {time(v.closedAt)}, total {money(v.totalCents)}
              </p>
              {v.scans.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing scanned.</p>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {v.scans.map((s, i) => (
                      <tr key={i} className={s.voided ? "text-muted-foreground line-through" : ""}>
                        <td className="w-20 py-0.5 tabular-nums">{time(s.ts)}</td>
                        <td className="py-0.5">{s.name}</td>
                        <td className="w-20 py-0.5 text-muted-foreground">{[s.colour, s.form].filter(Boolean).join(" ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="space-y-2">
              {v.hints.length === 0 && (
                <p className="text-xs text-muted-foreground">No camera hints in the purchase window.</p>
              )}
              {v.hints.map((h, i) => (
                <div key={i} className="rounded border border-border p-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono">{h.cameraId}</span>
                    <span className="tabular-nums text-muted-foreground">{time(h.start)}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${OUTCOME[h.outcome].cls}`}>
                      {OUTCOME[h.outcome].label}
                    </span>
                  </div>
                  <p className="mt-1">{h.text || "(no text)"}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{h.reason}</p>
                </div>
              ))}
            </div>
          </section>

        </div>
      </DialogContent>
    </Dialog>
  );
}
