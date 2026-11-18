import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { withRequestContext } from "@/lib/with-request-context";
import {
  ProbeUrlSchema,
  SOURCE_ID_RE,
  SourceInputSchema,
  sourceIdFromName,
  toSourceView,
} from "@/lib/sources";
import { lastSourceEvents, newSourceToken, probeSourceHealth } from "@/lib/source-events";
import { getPullStates } from "@/lib/source-poll";
import type { SourceEntry } from "@/lib/config-store/types";

export const dynamic = "force-dynamic";

// ─── GET — list with health, last event and pull state ───────────────────────
// `?probe=<baseUrl>` instead answers the health of an address not saved yet
// (the form's "Test connection").

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const probe = new URL(req.url).searchParams.get("probe");
  if (probe !== null) {
    const url = ProbeUrlSchema.safeParse(probe);
    if (!url.success) return NextResponse.json({ error: "probe must be an http(s) URL" }, { status: 400 });
    return NextResponse.json({ health: await probeSourceHealth(url.data) });
  }

  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  let sources: SourceEntry[];
  try {
    const ctx = await makeReconcileContext();
    sources = await ctx.store.readSources(ctx.instance);
  } catch (err) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    return NextResponse.json({ sources: [], warnings: [`config store unavailable: ${msg}`] });
  }

  const warnings: string[] = [];
  let last = new Map<string, { event: string; receivedAt: string; sessionId?: string | number }>();
  try {
    last = lastSourceEvents();
  } catch (err) {
    warnings.push(`event log unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pull = getPullStates();
  const health = await Promise.all(sources.map((s) => (s.baseUrl ? probeSourceHealth(s.baseUrl) : undefined)));
  return NextResponse.json({
    sources: sources.map((s, i) => ({
      ...toSourceView(s),
      lastEvent: last.get(s.id) ?? null,
      ...(health[i] ? { health: health[i] } : {}),
      ...(pull.has(s.id) ? { pull: pull.get(s.id) } : {}),
    })),
    warnings,
  });
}

// ─── POST — add a source; the only answer that carries its token ─────────────

export const POST = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = SourceInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  // The id is the event-input URL's path segment: given, or derived from the name.
  const given = (body as { id?: unknown }).id;
  const id = typeof given === "string" && given ? given : sourceIdFromName(input.name);
  if (!SOURCE_ID_RE.test(id)) {
    return NextResponse.json(
      { error: "id must be lowercase letters, digits, dot, dash or underscore (max 63)" },
      { status: 400 },
    );
  }

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  const ctx = await makeReconcileContext();
  if ((await ctx.store.readSources(ctx.instance)).some((s) => s.id === id)) {
    return NextResponse.json({ error: `source "${id}" already exists` }, { status: 409 });
  }

  const { token, tokenHash } = newSourceToken();
  const entry: SourceEntry = {
    id,
    name: input.name,
    type: input.type,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    mode: input.mode,
    tokenHash,
    enabled: input.enabled,
    createdAt: new Date().toISOString(),
  };
  await ctx.store.upsertSource(ctx.instance, entry, session.user?.email ?? "console");
  await auditLog("source-add", `source/${id}`, { type: entry.type, mode: entry.mode });
  return NextResponse.json({ source: toSourceView(entry), token }, { status: 201 });
});
