import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { SourceEventInputSchema, TillEventInputSchema } from "@/lib/sources";
import { listSourceEvents, recordSourceEvent, tokenMatches } from "@/lib/source-events";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_BODY = 64 * 1024;

/**
 * The event input. A source posts one JSON event per request. No user session:
 * proxy.ts lets exactly this path and method through, and the source's token is
 * the authentication, as `Authorization: Bearer <token>` or `?token=<token>`
 * (scanlog's webhook can only be given a URL). Answers 202 at once; nothing here
 * waits on anything but the store read and one SQLite insert.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const token = bearer ?? new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  let source;
  try {
    const ctx = await makeReconcileContext();
    source = (await ctx.store.readSources(ctx.instance)).find((s) => s.id === id);
  } catch {
    return NextResponse.json({ error: "config store unavailable" }, { status: 503 });
  }
  if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });
  if (!tokenMatches(token, source.tokenHash)) return NextResponse.json({ error: "invalid token" }, { status: 401 });
  if (!source.enabled) return NextResponse.json({ error: "source disabled" }, { status: 403 });

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
    return NextResponse.json({ error: "event too large" }, { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "event too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }
  const parsed = (source.type === "till" ? TillEventInputSchema : SourceEventInputSchema).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const ev = parsed.data;
  const { gap } = recordSourceEvent(id, {
    event: ev.event,
    ts: ev.ts_utc ?? null,
    seq: ev.seq ?? null,
    lane: ev.lane ?? null,
    payload: ev as Record<string, unknown>,
  });
  return NextResponse.json({ ok: true, gap }, { status: 202 });
}

/** The event log, newest first. `type` filters by event name. */
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), 500);
  const type = sp.get("type") || undefined;
  return NextResponse.json(listSourceEvents(id, { limit, ...(type ? { type } : {}) }));
}
