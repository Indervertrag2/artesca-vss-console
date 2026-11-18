"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";
import type { Scenario } from "@/lib/types";
import {
  DEFAULT_PRODUCT_CLASSES,
  DEFAULT_RULES,
  DEFAULT_SYSTEM_PROMPT,
  evidenceError,
  PRODUCT_FORMS,
  recordingSettings,
  type ProductClass,
  type PurchaseRules,
  type ScenarioMulti,
} from "@/lib/purchase-judge";

/** The last purchase the console judged for a scenario (GET /api/scenarios `purchaseStatus`). */
export interface PurchaseStatusView {
  purchaseId?: string;
  closedAt?: string;
  evaluatedAt?: string;
  incident?: boolean;
  summary?: string;
  error?: string;
}

interface Props {
  scenario: Scenario;
  onChange: (updated: Scenario) => void;
  cameraIds: string[];
  sourceIds: string[];
  status?: PurchaseStatusView;
}

const RULE_FIELDS: { key: keyof PurchaseRules; label: string; title: string }[] = [
  { key: "matchToleranceS", label: "Match tolerance (s)", title: "A hint is explained by a scan of a matching item this close to its chunk" },
  { key: "windowBeforeS", label: "Window before first scan (s)", title: "Seconds before the first scan of the last block of scans" },
  { key: "windowAfterS", label: "Window after payment (s)", title: "Seconds after the purchase ends" },
];

const EVIDENCE_FIELDS: { key: "chunkS" | "overlapS" | "framesPerSecond"; label: string; title: string }[] = [
  { key: "chunkS", label: "Chunk length (s)", title: "Length of each piece of the recording put to the model, 2 to 30 s" },
  { key: "overlapS", label: "Overlap (s)", title: "Seconds a chunk shares with the one before it, so an act on a border is whole in one of them" },
  { key: "framesPerSecond", label: "Frames per second", title: "Frames of a chunk the model looks at per second, 1 to 8; chunk length x frames per second is at most 60" },
];
const CROP_FIELDS = ["x", "y", "width", "height"] as const;

const select = "h-8 rounded-md border border-input bg-background px-2 text-xs";

const PurchasesSchema = z.object({
  sourceId: z.string(),
  purchases: z.array(
    z.object({
      purchaseId: z.string(),
      closedAt: z.string(),
      status: z.string(),
      scans: z.number(),
      totalCents: z.number().optional(),
      evaluatedAt: z.string().optional(),
      incident: z.boolean().optional(),
      summary: z.string().optional(),
    }),
  ),
});

async function call(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** The clock till's recent purchases with their verdicts, each with Re-evaluate:
 *  judge a past purchase (or one judged early) again from the bridge's alerts, or
 *  from its recording when that is the scenario's evidence. */
function RecentPurchases({ scenarioId }: { scenarioId: string }) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const url = `/api/scenarios/${encodeURIComponent(scenarioId)}/purchases`;
  const list = useQuery({
    queryKey: ["scenario-purchases", scenarioId],
    queryFn: async () => PurchasesSchema.parse(await call(url)),
    enabled: open,
  });
  const evaluate = useMutation({
    mutationFn: (purchaseId: string) =>
      call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purchaseId }) }) as Promise<{
        verdict: { incident: boolean; summary: string };
      }>,
    onSuccess: (r) => {
      toast({ title: r.verdict.incident ? "Incident" : "No incident", description: r.verdict.summary });
      void queryClient.invalidateQueries({ queryKey: ["scenario-purchases", scenarioId] });
    },
    onError: (err: Error) => toast({ title: "Re-evaluate failed", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <p className="font-medium">Recent purchases</p>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </Button>
        {open && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void list.refetch()}>
            Refresh
          </Button>
        )}
      </div>
      {open && list.isLoading && <p className="text-muted-foreground">Loading…</p>}
      {open && list.isError && <p className="text-amber-700">{list.error.message} (save the scenario first)</p>}
      {open && list.data && list.data.purchases.length === 0 && (
        <p className="text-muted-foreground">No finished purchase of {list.data.sourceId} in the event log.</p>
      )}
      {open && list.data && list.data.purchases.length > 0 && (
        <table className="w-full">
          <tbody>
            {list.data.purchases.map((p) => (
              <tr key={`${p.purchaseId}-${p.closedAt}`} className="border-t border-border align-top">
                <td className="py-1 pr-2 font-mono">{p.purchaseId}</td>
                <td className="py-1 pr-2 tabular-nums">{new Date(p.closedAt).toLocaleString()}</td>
                <td className="py-1 pr-2">
                  {p.status}, {p.scans} scanned{p.totalCents !== undefined ? `, ${(p.totalCents / 100).toFixed(2)}` : ""}
                </td>
                <td className="py-1 pr-2" title={p.summary}>
                  {p.evaluatedAt === undefined ? (
                    <span className="text-muted-foreground">not judged</span>
                  ) : p.incident ? (
                    <span className="text-red-700">incident</span>
                  ) : (
                    <span className="text-emerald-700">no incident</span>
                  )}
                </td>
                <td className="py-1 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={evaluate.isPending}
                    onClick={() => evaluate.mutate(p.purchaseId)}
                  >
                    {evaluate.isPending && evaluate.variables === p.purchaseId ? "Judging…" : "Re-evaluate"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * The multi-camera fields of a scenario: the cameras that work together, the
 * till that is the clock, the matching rules and the product classes. One
 * incident per purchase is raised from them (purchase-judge.ts).
 */
export function MultiCameraConfig({ scenario, onChange, cameraIds, sourceIds, status }: Props) {
  const camList = React.useId();
  const srcList = React.useId();
  const set = (patch: Partial<ScenarioMulti>) => onChange({ ...scenario, ...patch });
  const cameras = scenario.cameras ?? [];
  const sources = scenario.sources ?? [];
  const rules = scenario.rules ?? DEFAULT_RULES;
  const classes = scenario.productClasses;

  const setAt = <T,>(list: T[], i: number, value: T) => list.map((x, k) => (k === i ? value : x));
  const dropAt = <T,>(list: T[], i: number) => list.filter((_, k) => k !== i);

  const recording = scenario.evidence === "recording";
  const evidence = recordingSettings(scenario);
  const evidenceProblem = recording ? evidenceError(scenario) : null;
  /** One crop field of one camera; a crop with all four fields empty is no crop. */
  const setCrop = (i: number, key: (typeof CROP_FIELDS)[number], value: string) => {
    const { crop, ...rest } = cameras[i];
    const next = { x: 0, y: 0, width: 0, height: 0, ...crop, [key]: Math.max(0, Math.round(Number(value)) || 0) };
    set({ cameras: setAt(cameras, i, CROP_FIELDS.some((k) => next[k] > 0) ? { ...rest, crop: next } : rest) });
  };

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/20 p-3 text-xs">
      <p className="text-muted-foreground">
        Multi-camera: one incident per purchase of the clock till. The cameras&apos; alerts become hints, and
        hints the till explains (a matching item scanned at that moment, or a paid item carried away after
        payment) are discarded. No cooldown.
      </p>

      <datalist id={camList}>
        {cameraIds.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <datalist id={srcList}>
        {sourceIds.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>

      <div className="space-y-1.5">
        <p className="font-medium">Cameras</p>
        {cameras.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              list={camList}
              value={c.id}
              placeholder="camera id"
              aria-label="Camera id"
              className="h-8 w-44 text-xs"
              onChange={(e) => set({ cameras: setAt(cameras, i, { ...c, id: e.target.value.trim() }) })}
            />
            <Input
              value={c.view ?? ""}
              placeholder="what this camera sees, e.g. scanner glass from the front"
              aria-label="Camera view"
              className="h-8 flex-1 text-xs"
              onChange={(e) => set({ cameras: setAt(cameras, i, { ...c, view: e.target.value }) })}
            />
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Remove camera" onClick={() => set({ cameras: dropAt(cameras, i) })}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => set({ cameras: [...cameras, { id: "", view: "" }] })}>
          <Plus className="mr-1 h-3 w-3" /> Add camera
        </Button>
      </div>

      <div className="space-y-1.5">
        <p className="font-medium">External sources</p>
        {sources.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              list={srcList}
              value={s.id}
              placeholder="source id"
              aria-label="Source id"
              className="h-8 w-44 text-xs"
              onChange={(e) => set({ sources: setAt(sources, i, { ...s, id: e.target.value.trim() }) })}
            />
            <select
              className={select}
              aria-label="Source role"
              value={s.role}
              onChange={(e) => set({ sources: setAt(sources, i, { ...s, role: e.target.value as "clock" | "witness" }) })}
            >
              <option value="clock">clock (its purchases are judged)</option>
              <option value="witness">witness</option>
            </select>
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Remove source" onClick={() => set({ sources: dropAt(sources, i) })}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => set({ sources: [...sources, { id: "", role: sources.some((s) => s.role === "clock") ? "witness" : "clock" }] })}
        >
          <Plus className="mr-1 h-3 w-3" /> Add source
        </Button>
      </div>

      <div className="flex flex-wrap gap-4">
        {RULE_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center gap-2" title={f.title}>
            <span>{f.label}</span>
            <Input
              type="number"
              min={0}
              className="h-8 w-20 text-xs"
              value={rules[f.key]}
              onChange={(e) => set({ rules: { ...rules, [f.key]: Number(e.target.value) || 0 } })}
            />
          </label>
        ))}
      </div>

      <div className="space-y-1.5">
        <p className="font-medium">Evidence</p>
        <select
          className={select}
          aria-label="Evidence"
          value={recording ? "recording" : "live"}
          onChange={(e) => set({ evidence: e.target.value === "recording" ? "recording" : undefined })}
        >
          <option value="live">Live alerts</option>
          <option value="recording">Recording of the purchase</option>
        </select>
        {!recording ? (
          <p className="text-muted-foreground">
            The hints are the alerts the model raises on the live streams, in their fixed chunks.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              When a purchase ends, each camera&apos;s recording of the purchase window is cut into overlapping
              chunks and the model is asked the question about every one of them, one at a time. Judged about a
              minute after the window closes, once the recording is complete.
            </p>
            <div className="flex flex-wrap gap-4">
              {EVIDENCE_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-2" title={f.title}>
                  <span>{f.label}</span>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 w-20 text-xs"
                    value={evidence[f.key]}
                    onChange={(e) => set({ [f.key]: Number(e.target.value) || 0 })}
                  />
                </label>
              ))}
            </div>
            <label className="block space-y-1">
              <span className="flex items-center gap-2">
                Question
                {scenario.question !== undefined && (
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => set({ question: undefined })}>
                    Use default
                  </Button>
                )}
              </span>
              <textarea
                aria-label="Question"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                value={evidence.question}
                onChange={(e) => set({ question: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span>System prompt (optional)</span>
              <Input
                aria-label="System prompt"
                className="h-8 text-xs"
                value={scenario.systemPrompt ?? ""}
                placeholder={DEFAULT_SYSTEM_PROMPT}
                onChange={(e) => set({ systemPrompt: e.target.value || undefined })}
              />
            </label>
            {cameras.length > 0 && (
              <div className="space-y-1">
                <p title="The part of the camera's picture the model is shown, in pixels of the source picture. A ceiling camera shows the checkout too small otherwise.">
                  Crop per camera (optional, pixels of the source picture; empty = the whole picture)
                </p>
                {cameras.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-44 truncate font-mono">{c.id || "(no id)"}</span>
                    {CROP_FIELDS.map((k) => (
                      <Input
                        key={k}
                        type="number"
                        min={0}
                        aria-label={`Crop ${k} of ${c.id}`}
                        placeholder={k}
                        className="h-8 w-20 text-xs"
                        value={c.crop?.[k] || ""}
                        onChange={(e) => setCrop(i, k, e.target.value)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
            {evidenceProblem && (
              <p role="alert" className="text-amber-700">
                {evidenceProblem}
              </p>
            )}
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="font-medium">Product classes</p>
        {!classes ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              Defaults from product names: bottle for drinks, bag for snacks and gummies, box for crackers.
            </span>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => set({ productClasses: DEFAULT_PRODUCT_CLASSES.map((c) => ({ ...c })) })}>
              Customize
            </Button>
          </div>
        ) : (
          <>
            {classes.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={c.pattern}
                  placeholder="name fragments, separated by |"
                  aria-label="Product name pattern"
                  className="h-8 flex-1 text-xs"
                  onChange={(e) => set({ productClasses: setAt(classes, i, { ...c, pattern: e.target.value }) })}
                />
                <select
                  className={select}
                  aria-label="Form"
                  value={c.form}
                  onChange={(e) => set({ productClasses: setAt(classes, i, { ...c, form: e.target.value as ProductClass["form"] }) })}
                >
                  {PRODUCT_FORMS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <Input
                  value={c.colour ?? ""}
                  placeholder="colour (optional)"
                  aria-label="Colour"
                  className="h-8 w-32 text-xs"
                  onChange={(e) => {
                    const { colour: _drop, ...rest } = c;
                    void _drop;
                    set({ productClasses: setAt(classes, i, e.target.value ? { ...rest, colour: e.target.value } : rest) });
                  }}
                />
                <Button variant="ghost" size="icon" className="h-7 w-7" title="Remove class" onClick={() => set({ productClasses: dropAt(classes, i) })}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => set({ productClasses: [...classes, { pattern: "", form: "bag" }] })}
              >
                <Plus className="mr-1 h-3 w-3" /> Add class
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => set({ productClasses: undefined })}>
                Use defaults
              </Button>
            </div>
          </>
        )}
      </div>

      <RecentPurchases scenarioId={scenario.id} />

      <p className={status?.error ? "text-amber-700" : "text-muted-foreground"}>
        {status?.purchaseId
          ? `Last judged: purchase ${status.purchaseId}, ${status.incident ? "incident" : "no incident"}` +
            (status.evaluatedAt ? ` (${new Date(status.evaluatedAt).toLocaleString()})` : "") +
            (status.summary ? `. ${status.summary}` : "")
          : "No purchase judged yet."}
        {status?.error ? ` Not judging: ${status.error}` : ""}
      </p>
    </div>
  );
}
