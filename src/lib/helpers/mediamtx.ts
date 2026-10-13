import "server-only";
import { CLUSTER } from "../cluster-refs";
import { createLogger } from "@/lib/logger";

const log = createLogger("mediamtx");

// mediamtx REST API is on port 9997 of the camera-sim host
// (k8s/nvidia-vss/pyramid-ingress/21-replay-server.yaml).  Override via MEDIAMTX_API_URL
// or set CAMERA_SIM_HOST to the EC2 public IP/DNS.
//
// The API is behind HTTP basic auth: user `camsim` (override MEDIAMTX_API_USER),
// password CAMSIM_PASS from the console-auth Secret (envFrom). The password is
// read per call, sent only in the Authorization header and never logged.
const MEDIAMTX_API = CLUSTER.mediamtx.apiUrl;

export const MEDIAMTX_MISSING_CREDENTIALS_WARNING =
  "mediamtx API credentials missing: set CAMSIM_PASS (the camsim password from /opt/camera-sim/.env on the camera-sim VM) in the console-auth Secret";

/** Basic-auth header for the mediamtx API, or null when CAMSIM_PASS is unset. */
export function mediamtxAuthHeader(): string | null {
  const pass = process.env.CAMSIM_PASS ?? "";
  if (pass === "") return null;
  const user = process.env.MEDIAMTX_API_USER || "camsim";
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function httpWarning(what: string, status: number): string {
  return status === 401 || status === 403
    ? `${what} rejected the camsim credentials (HTTP ${status}): check CAMSIM_PASS against /opt/camera-sim/.env on the VM`
    : `${what} returned HTTP ${status}`;
}

export interface MediamtxPath {
  name: string;
  ready: boolean;
  readyTime?: string;
  tracks?: string[];
  bytesReceived?: number;
  bytesSent?: number;
  readers?: Array<{ type: string; id: string }>;
  [key: string]: unknown;
}

export interface MediamtxPathsResponse {
  items: MediamtxPath[];
  pageCount?: number;
}

/** List all paths on mediamtx. Returns empty list if unreachable. */
export async function mediamtxListPaths(): Promise<{
  paths: MediamtxPath[];
  warning?: string;
}> {
  const auth = mediamtxAuthHeader();
  if (!auth) return { paths: [], warning: MEDIAMTX_MISSING_CREDENTIALS_WARNING };
  try {
    const resp = await fetch(`${MEDIAMTX_API}/v3/paths/list`, {
      headers: { Authorization: auth },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      return {
        paths: [],
        warning: httpWarning("mediamtx", resp.status),
      };
    }

    const json = (await resp.json()) as MediamtxPathsResponse | MediamtxPath[];

    const paths = Array.isArray(json)
      ? json
      : (json as MediamtxPathsResponse).items ?? [];

    return { paths };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("unreachable", { err });
    return { paths: [], warning: `mediamtx unreachable: ${msg}` };
  }
}

/** Get status for a single path. */
export async function mediamtxPathStatus(
  pathName: string
): Promise<{ path: MediamtxPath | null; warning?: string }> {
  const auth = mediamtxAuthHeader();
  if (!auth) return { path: null, warning: MEDIAMTX_MISSING_CREDENTIALS_WARNING };
  try {
    const resp = await fetch(
      `${MEDIAMTX_API}/v3/paths/get/${encodeURIComponent(pathName)}`,
      {
        headers: { Authorization: auth },
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(5_000),
      }
    );

    if (!resp.ok) {
      return {
        path: null,
        warning: httpWarning(`mediamtx path ${pathName}`, resp.status),
      };
    }

    const path = (await resp.json()) as MediamtxPath;
    return { path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: null, warning: `mediamtx path query failed: ${msg}` };
  }
}

// Re-export base URL helper for use in other helpers
export { MEDIAMTX_API };
