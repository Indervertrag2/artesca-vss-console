// "Chat about this incident": the incident dialog links to /chat with the
// sensor and window as query params; /chat scopes to the sensor and prefills an
// editable question from them.

/** Margin around the incident window for the agent's video understanding. */
const MARGIN_MS = 30_000;

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function incidentChatHref(sensorId: string, ts: string, end?: unknown): string {
  const q = typeof end === "string" && end ? `&end=${encodeURIComponent(end)}` : "";
  return `/chat?sensor=${encodeURIComponent(sensorId)}&ts=${encodeURIComponent(ts)}${q}`;
}

/** What /chat scopes to when opened from an incident: the incident's recording,
 *  not the live camera. `from`/`to` are the recording window (±30 s margin). */
export interface IncidentChatPrefill {
  sensor: string;
  question: string;
  from: string;
  to: string;
}

/** Appended to each follow-up while the chat is scoped to an incident recording,
 *  so the agent keeps answering from that window instead of the live feed. */
export function incidentScopeNote(p: IncidentChatPrefill): string {
  return ` (about the recorded incident on sensor ${p.sensor}, recording from ${p.from} to ${p.to}: answer from this recording, not from the live camera)`;
}

/** Scope + question from /chat's query string; null without a sensor and a valid ts.
 *  Timestamps go out as toISOString() (YYYY-MM-DDTHH:MM:SS.sssZ), the format the
 *  agent's prompt requires. */
export function incidentChatPrefill(search: string): IncidentChatPrefill | null {
  const p = new URLSearchParams(search);
  const sensor = p.get("sensor")?.trim();
  const start = parseDate(p.get("ts"));
  if (!sensor || !start) return null;
  const parsedEnd = parseDate(p.get("end"));
  const end = parsedEnd && parsedEnd > start ? parsedEnd : null;
  const from = new Date(start.getTime() - MARGIN_MS).toISOString();
  const to = new Date((end ?? start).getTime() + MARGIN_MS).toISOString();
  const until = end ? ` (until ${end.toISOString()})` : "";
  return {
    sensor,
    from,
    to,
    question:
      `Tell me about the incident on sensor ${sensor} at ${start.toISOString()}${until}. ` +
      `Use the incident from rtvi_vlm_alert get_incidents for sensor ${sensor} and run video understanding from ${from} to ${to}. ` +
      `What happened, which products were involved, and was anything taken without being scanned?`,
  };
}
