import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { SourceInputSchema, toSourceView } from "@/lib/sources";
import { deleteSourceEvents } from "@/lib/source-events";
import type { SourceEntry } from "@/lib/config-store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function find(id: string) {
  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  const ctx = await makeReconcileContext();
  const source = (await ctx.store.readSources(ctx.instance)).find((s) => s.id === id);
  return { ctx, source };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { source } = await find(id);
  if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });
  return NextResponse.json({ source: toSourceView(source) });
}

/** Replace name, type, address, lane, mode and enabled. The id, token and
 *  createdAt stay; a field left out is cleared, since upsert replaces the entity. */
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;
  const { id } = await params;

  const parsed = SourceInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const { ctx, source } = await find(id);
  if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });

  const input = parsed.data;
  const next: SourceEntry = {
    id,
    name: input.name,
    type: input.type,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    mode: input.mode,
    tokenHash: source.tokenHash,
    enabled: input.enabled,
    createdAt: source.createdAt,
  };
  await ctx.store.upsertSource(ctx.instance, next, session.user?.email ?? "console");
  await auditLog("source-update", `source/${id}`, { type: next.type, mode: next.mode, enabled: next.enabled });
  return NextResponse.json({ source: toSourceView({ ...next, updatedAt: new Date().toISOString() }) });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;
  const { id } = await params;

  const { ctx, source } = await find(id);
  if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });
  await ctx.store.deleteSource(ctx.instance, id, session.user?.email ?? "console");
  deleteSourceEvents(id);
  await auditLog("source-delete", `source/${id}`, {});
  return NextResponse.json({ ok: true });
}
