"use client";

import { useState } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MessageSquare, Video } from "lucide-react";
import { incidentChatHref, incidentClipUrl } from "@/lib/incident-chat";
import { money, purchaseChatQuestion, type HintOutcome, type PurchaseVerdict } from "@/lib/purchase-judge";
import { ClipPlayer } from "./ClipPlayer";
import type { Incident } from "@/lib/types";

// The detail of a purchase incident (multi-camera scenario): the till record,
// every camera hint with the rule that discarded it or why it remained, one clip
// per camera loaded only on request, and a chat that starts from the till data.

const OUTCOME: Record<HintOutcome, { label: string; cls: string }> = {
  remains: { label: "not explained", cls: "bg-red-50 text-red-700 border-red-200" },
  scanned: { label: "rule 1: scanned", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paid: { label: "rule 2: paid", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  negative: { label: "answer no", cls: "bg-muted text-muted-foreground border-border" },
};

const time = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

interface Props {
  incident: Incident;
  verdict: PurchaseVerdict;
  onClose: () => void;
}

export function PurchaseIncidentDetail({ incident, verdict: v, onClose }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const w = v.window ?? { start: v.closedAt, end: v.closedAt };
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-red-700">
              {incident.severity}
            </span>
            <span>{v.scenarioName}</span>
            <span className="font-mono text-sm">purchase {v.purchaseId}</span>
            <span className="text-xs text-muted-foreground">{new Date(v.closedAt).toLocaleString()}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-5 text-sm">
          <p>{v.summary}</p>

          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Why</h3>

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

          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Cameras</h3>
            {v.cameras.map((c) => (
              <div key={c.id} className="rounded border border-border p-2">
                {/* The text wraps, the button never does: every camera's button sits in the same right-hand column. */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 pt-1.5 text-xs">
                    <span className="font-mono">{c.id}</span>
                    {c.view && <span className="ml-2 text-muted-foreground">{c.view}</span>}
                    <span className="ml-2">{v.camerasSaw.includes(c.id) ? "saw it" : "no unexplained hint"}</span>
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
          </section>

          <Button asChild variant="outline" size="sm" className="h-7 px-2 text-[11px]">
            <Link href={incidentChatHref(incident.sensorId, w.start, w.end, purchaseChatQuestion(v))}>
              <MessageSquare className="mr-1.5 h-3 w-3" />
              Chat about this incident
            </Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
