"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { z } from "zod";
import { KeyRound, Loader2, Pencil, PlusCircle, RefreshCw, Save, Trash2 } from "lucide-react";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { CamerasSubnav } from "@/components/cameras/CamerasSubnav";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  SOURCE_MODES,
  SOURCE_MODE_LABEL,
  SOURCE_TYPES,
  SOURCE_TYPE_LABEL,
  SourceEventsResponseSchema,
  SourceHealthSchema,
  SourceViewSchema,
  TILL_EVENTS,
  eventDetails,
  eventInputPath,
  type SourceMode,
  type SourceType,
  type SourceView,
} from "@/lib/sources";

// ─── Data ──────────────────────────────────────────────────────────────────────

const ListSchema = z.object({
  sources: z.array(SourceViewSchema),
  warnings: z.array(z.string()).optional(),
});

async function call(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ─── Small pieces ──────────────────────────────────────────────────────────────

/** A source counts as receiving while its last event is younger than this. */
const RECEIVING_MS = 2 * 60_000;

const TAG = "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium";
const TONE = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  bad: "border-red-200 bg-red-50 text-red-700",
  off: "border-border bg-muted text-muted-foreground",
  info: "border-sky-200 bg-sky-50 text-sky-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
};

const EVENT_TONE: Record<string, string> = {
  purchase_started: TONE.ok,
  item_scanned: TONE.info,
  item_voided: TONE.warn,
  purchase_closed: TONE.ok,
  purchase_cancelled: TONE.off,
  purchase_timeout: TONE.off,
  weight_mismatch: TONE.bad,
  staff_called: "border-orange-200 bg-orange-50 text-orange-700",
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
const seconds = (ms: number) => `${ms < 0 ? "−" : "+"}${Math.abs(ms / 1000).toFixed(1)} s`;
const isReceiving = (s: SourceView) =>
  !!s.lastEvent && Date.now() - Date.parse(s.lastEvent.receivedAt) < RECEIVING_MS;

function EventTag({ event }: { event: string }) {
  return <span className={cn(TAG, "font-mono", EVENT_TONE[event] ?? TONE.off)}>{event}</span>;
}

function Dot({ s }: { s: SourceView }) {
  const receiving = s.enabled && isReceiving(s);
  const tone = !s.enabled
    ? "bg-muted-foreground/30"
    : receiving || s.health?.reachable
      ? "bg-emerald-500"
      : s.health
        ? "bg-red-500"
        : "bg-muted-foreground/30";
  return <span className={cn("inline-block h-2 w-2 rounded-full", tone, receiving && "animate-pulse")} />;
}

function StatusCell({ s }: { s: SourceView }) {
  const h = s.health;
  const [text, tone] = !s.enabled
    ? ["disabled", TONE.off]
    : !h
      ? ["no address", TONE.off]
      : h.reachable
        ? ["reachable", TONE.ok]
        : ["unreachable", TONE.bad];
  const healthLine = h
    ? [h.status ? `health ${h.status}` : h.error, h.clockOffsetMs !== undefined ? `clock offset ${seconds(h.clockOffsetMs)}` : null]
        .filter(Boolean)
        .join(" · ")
    : null;
  const p = s.pull;
  const pullLine =
    s.mode === "push" || !s.enabled
      ? null
      : !p
        ? "pull: waiting for the first pass"
        : p.error
          ? `pull failed ${clock(p.lastPollAt)}: ${p.error}`
          : `pull ok ${clock(p.lastPollAt)}${p.added ? ` · ${p.added} new` : ""}`;
  return (
    <div>
      <span className={cn(TAG, tone)}>{text}</span>
      {healthLine && <div className="mt-0.5 text-[11px] text-muted-foreground">{healthLine}</div>}
      {pullLine && (
        <div className={cn("mt-0.5 text-[11px]", p?.error ? "text-red-700" : "text-muted-foreground")}>{pullLine}</div>
      )}
    </div>
  );
}

// ─── Form ──────────────────────────────────────────────────────────────────────

interface Form {
  name: string;
  type: SourceType;
  baseUrl: string;
  lane: string;
  mode: SourceMode;
  enabled: boolean;
}

const EMPTY: Form = { name: "", type: "till", baseUrl: "", lane: "", mode: "push", enabled: true };

const INPUT = "w-full rounded border border-input bg-background px-2 py-1.5 text-sm";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function ExternalSourcesPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const formRef = React.useRef<HTMLInputElement>(null);

  const [selected, setSelected] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [formMsg, setFormMsg] = React.useState<string | null>(null);
  /** The token, held only until the page is left: the API returns it once. */
  const [revealed, setRevealed] = React.useState<{ id: string; token: string } | null>(null);
  const [origin, setOrigin] = React.useState("");
  React.useEffect(() => setOrigin(window.location.origin), []);

  const list = useQuery({
    queryKey: ["sources"],
    queryFn: async () => ListSchema.parse(await call("/api/sources")),
    refetchInterval: 5_000,
  });
  const sources = list.data?.sources ?? [];
  const current = sources.find((s) => s.id === selected) ?? sources[0];

  const events = useQuery({
    queryKey: ["sources", current?.id, "events", filter],
    enabled: !!current,
    queryFn: async () =>
      SourceEventsResponseSchema.parse(
        await call(`${eventInputPath(current!.id)}?limit=200${filter ? `&type=${encodeURIComponent(filter)}` : ""}`),
      ),
    refetchInterval: 3_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sources"] });
  const fail = (title: string) => (err: Error) => toast({ title, description: err.message, variant: "destructive" });

  const save = useMutation({
    mutationFn: async () => {
      const body = { ...form, mode: form.type === "till" ? form.mode : "push" };
      return editing
        ? call(`/api/sources/${editing}`, json("PUT", body))
        : (call("/api/sources", json("POST", body)) as Promise<{ source: { id: string }; token: string }>);
    },
    onSuccess: (res) => {
      const created = res as { source?: { id: string }; token?: string };
      if (!editing && created.source && created.token) {
        setRevealed({ id: created.source.id, token: created.token });
        setSelected(created.source.id);
        setFormMsg("Added. Configure the source with the address on the right; the token is shown only now.");
      } else {
        setFormMsg("Saved.");
      }
      toast({ title: editing ? "Source saved" : "Source added" });
      setEditing(null);
      setForm(EMPTY);
      refresh();
    },
    onError: fail("Save failed"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => call(`/api/sources/${id}`, { method: "DELETE" }),
    onSuccess: (_r, id) => {
      toast({ title: `Source ${id} deleted` });
      if (selected === id) setSelected(null);
      refresh();
    },
    onError: fail("Delete failed"),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => call(`/api/sources/${id}/token`, { method: "POST" }) as Promise<{ token: string }>,
    onSuccess: (r, id) => {
      setRevealed({ id, token: r.token });
      toast({ title: "Token rotated", description: "The old token no longer works." });
    },
    onError: fail("Rotate failed"),
  });

  const test = useMutation({
    mutationFn: async (baseUrl: string) =>
      SourceHealthSchema.parse(
        ((await call(`/api/sources?probe=${encodeURIComponent(baseUrl)}`)) as { health: unknown }).health,
      ),
    onSuccess: (h) =>
      setFormMsg(
        h.reachable
          ? [
              `Reachable, health ${h.status}`,
              h.clockOffsetMs !== undefined ? `clock offset ${seconds(h.clockOffsetMs)}` : null,
              h.lane ? `lane ${h.lane}` : null,
              h.version ? `version ${h.version}` : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : `Not reachable: ${h.status ? `health ${h.status}` : h.error}`,
      ),
    onError: (err: Error) => setFormMsg(err.message),
  });

  const startAdd = () => {
    setEditing(null);
    setForm(EMPTY);
    setFormMsg(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    formRef.current?.focus();
  };

  const startEdit = (s: SourceView) => {
    setEditing(s.id);
    setForm({
      name: s.name,
      type: s.type,
      baseUrl: s.baseUrl ?? "",
      lane: s.lane ?? "",
      mode: s.mode,
      enabled: s.enabled,
    });
    setFormMsg(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const counts = events.data?.counts ?? {};
  const chipTypes =
    current?.type === "till"
      ? [...TILL_EVENTS, ...Object.keys(counts).filter((k) => !(TILL_EVENTS as readonly string[]).includes(k))]
      : Object.keys(counts).sort();
  const inputUrl = current ? `${origin}${eventInputPath(current.id)}` : "";
  const token = current && revealed?.id === current.id ? revealed.token : "<token>";

  return (
    <Shell>
      <div className="max-w-6xl mx-auto space-y-4">
        <CamerasSubnav />

        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">External Sources</h2>
            <p className="text-sm text-muted-foreground">
              Sources that are not cameras, such as tills and scales. They send their events to the console, or the
              console reads them, so that scenarios can use them as a clock or a witness.
            </p>
          </div>
          <Button onClick={startAdd}>
            <PlusCircle className="h-4 w-4 mr-2" />
            Add Source
          </Button>
        </div>

        {(list.data?.warnings ?? []).map((w) => (
          <div key={w} className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {w}
          </div>
        ))}
        {list.isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load sources: {(list.error as Error).message}
          </div>
        )}

        <div className="rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Address</th>
                <th className="px-3 py-2 font-medium">Lane</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Last event</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Loading sources...
                  </td>
                </tr>
              )}
              {!list.isLoading && sources.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-muted-foreground">
                    No external sources. Add one to receive its events.
                  </td>
                </tr>
              )}
              {sources.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => {
                    setSelected(s.id);
                    setFilter(null);
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/50 last:border-0 hover:bg-muted/20",
                    current?.id === s.id && "bg-accent/60",
                  )}
                >
                  <td className="px-3 py-2">
                    <Dot s={s} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-mono">{s.name}</div>
                    {s.name !== s.id && <div className="font-mono text-[11px] text-muted-foreground">{s.id}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn(TAG, s.type === "scale" ? TONE.info : "border-primary/30 bg-accent text-accent-foreground")}>
                      {SOURCE_TYPE_LABEL[s.type]}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{s.baseUrl ?? <span className="text-muted-foreground">-</span>}</td>
                  <td className="px-3 py-2 font-mono">{s.lane ?? <span className="text-muted-foreground">-</span>}</td>
                  <td className="px-3 py-2 text-xs">{s.mode}</td>
                  <td className="px-3 py-2">
                    <StatusCell s={s} />
                  </td>
                  <td className="px-3 py-2">
                    {s.lastEvent ? (
                      <div>
                        <EventTag event={s.lastEvent.event} />
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {clock(s.lastEvent.receivedAt)}
                          {s.lastEvent.sessionId !== undefined && ` · purchase #${s.lastEvent.sessionId}`}
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">none yet</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Edit"
                      aria-label={`Edit ${s.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(s);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Delete"
                      aria-label={`Delete ${s.id}`}
                      className="text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete source ${s.id} and its event log?`)) remove.mutate(s.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {current && (
          <div className="rounded-md border border-border p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">Event log</h3>
                <span className="font-mono text-sm text-muted-foreground">{current.id}</span>
                {isReceiving(current) && (
                  <span className="flex items-center gap-1 text-xs text-emerald-700">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                    receiving
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                seq gaps: {events.data?.gaps ? `${events.data.gaps} missing` : "none"} · kept 7 days
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {chipTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setFilter(filter === t ? null : t)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 font-mono text-xs",
                    filter === t ? "border-primary bg-accent text-accent-foreground" : "border-border",
                    !counts[t] && filter !== t && "text-muted-foreground/60",
                  )}
                >
                  {t} <span className="text-muted-foreground">{counts[t] ?? 0}</span>
                </button>
              ))}
            </div>

            <div className="rounded-md border border-border overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                    <th className="w-16 px-3 py-1.5 font-medium">seq</th>
                    <th className="w-24 px-3 py-1.5 font-medium">Time</th>
                    <th className="w-44 px-3 py-1.5 font-medium">Event</th>
                    <th className="w-24 px-3 py-1.5 font-medium">Purchase</th>
                    <th className="px-3 py-1.5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {(events.data?.events ?? []).map((ev) => (
                    <React.Fragment key={ev.id}>
                      <tr className="border-b border-border/50">
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">{ev.seq ?? "-"}</td>
                        <td className="px-3 py-1.5 font-mono">{clock(ev.ts ?? ev.receivedAt)}</td>
                        <td className="px-3 py-1.5">
                          <EventTag event={ev.event} />
                        </td>
                        <td className="px-3 py-1.5 font-mono">
                          {ev.payload.session_id != null ? `#${String(ev.payload.session_id)}` : ""}
                        </td>
                        <td className="px-3 py-1.5">{eventDetails(ev.payload)}</td>
                      </tr>
                      {ev.gap > 0 && (
                        <tr className="border-b border-border/50 bg-amber-50/60">
                          <td colSpan={5} className="px-3 py-1 text-amber-700">
                            {ev.gap} event{ev.gap === 1 ? "" : "s"} missing before seq {ev.seq}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {events.data && events.data.events.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-5 text-center text-muted-foreground">
                        {filter ? "No events of this type." : "Waiting for the first event."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <form
            className="rounded-md border border-border p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <h3 className="font-semibold">{editing ? `Edit source ${editing}` : "Add source"}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Name</span>
                <input
                  ref={formRef}
                  required
                  className={INPUT}
                  placeholder="e.g. lane-2-till"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Type</span>
                <select
                  className={INPUT}
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as SourceType })}
                >
                  {SOURCE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {SOURCE_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Base URL</span>
                <input
                  className={cn(INPUT, "font-mono")}
                  placeholder="http://<host>:8181"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Lane</span>
                <input
                  className={cn(INPUT, "font-mono")}
                  placeholder="e.g. lane-2"
                  value={form.lane}
                  onChange={(e) => setForm({ ...form, lane: e.target.value })}
                />
              </label>
              {form.type === "till" && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Mode</span>
                  <select
                    className={INPUT}
                    value={form.mode}
                    onChange={(e) => setForm({ ...form, mode: e.target.value as SourceMode })}
                  >
                    {SOURCE_MODES.map((m) => (
                      <option key={m} value={m}>
                        {SOURCE_MODE_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 self-end pb-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="flex justify-end gap-2">
              {editing && (
                <Button type="button" variant="ghost" size="sm" onClick={startAdd}>
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!form.baseUrl || test.isPending}
                onClick={() => test.mutate(form.baseUrl)}
              >
                <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", test.isPending && "animate-spin")} />
                Test connection
              </Button>
              <Button type="submit" size="sm" disabled={save.isPending}>
                {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                {editing ? "Save" : "Add source"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {formMsg ?? (
                <>
                  Test connection calls <span className="font-mono">GET &lt;base URL&gt;/api/health</span> and measures
                  the clock offset. Pull reads <span className="font-mono">/api/sessions</span> and{" "}
                  <span className="font-mono">/api/scans</span> of a till every few seconds.
                </>
              )}
            </p>
          </form>

          {current && (
            <div className="rounded-md border border-border p-4 space-y-2 text-xs">
              <h3 className="text-sm font-semibold">Event input</h3>
              {current.mode !== "push" && (
                <p className="text-muted-foreground">
                  Pull is on: the console reads this till itself and stores the same events, without duplicates.
                  {current.mode === "both" ? " Pushed events land in the same log." : " Nothing needs to be set on the till."}
                </p>
              )}
              <p className="text-muted-foreground">The source sends its events to the console. Configure it with this address:</p>
              <code className="block select-all break-all rounded bg-muted px-2 py-1.5 font-mono">POST {inputUrl}</code>
              <p className="text-muted-foreground">
                Authenticate with <span className="font-mono">Authorization: Bearer {token}</span>, or append{" "}
                <span className="font-mono">?token=</span> for a sender that only takes a URL. For scanlog, start it once with:
              </p>
              <code className="block select-all break-all rounded bg-muted px-2 py-1.5 font-mono">
                scanlog -webhook &quot;{inputUrl}?token={token}&quot;
              </code>
              {revealed?.id === current.id ? (
                <p className="font-medium text-amber-700">Copy the token now. It is not shown again.</p>
              ) : (
                <p className="text-muted-foreground">
                  The token is shown once, when the source is added. Lost it? Rotate it; the old one stops working.
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <p className="text-muted-foreground">
                  Each event carries its type, lane, time and a running number <span className="font-mono">seq</span>.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rotate.isPending}
                  onClick={() => {
                    if (confirm(`Rotate the token of ${current.id}? The source must then be given the new one.`)) {
                      rotate.mutate(current.id);
                    }
                  }}
                >
                  <KeyRound className="h-3.5 w-3.5 mr-1.5" />
                  Rotate token
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
