import type { CameraEntry } from "@/lib/helpers/gcs-config";
import type { ScenarioMulti } from "@/lib/purchase-judge";

export type { CameraEntry };

/** VLM system prompt stored in the config store. */
export interface PromptDoc {
  prompt: string;
  model?: string;
}

/** A named, reusable VLM system prompt ("use case"). */
export interface PromptSet { id: string; name: string; text: string; model?: string; alertType?: string }

/** A single alert-scenario entry stored in the config store. The multi-camera
 *  fields (`mode: "multi"`, cameras, sources, rules, productClasses) are present
 *  only on a multi-camera scenario; see purchase-judge.ts. */
export interface ScenarioEntry extends ScenarioMulti {
  id: string;
  name: string;
  description?: string;
  severity: "low" | "medium" | "high" | "critical";
  channels: ("ui" | "slack")[];
  sensor_filter: string;
  keywords: string[];
  enabled: boolean;
  cooldown_seconds?: number;
}

/**
 * An external source: an input that is not a camera (a till, a scale). It pushes
 * its events to `POST /api/sources/<id>/events`, authenticated by its token.
 *
 * Only the SHA-256 of the token is stored. The token is 32 random bytes, so a
 * plain hash is enough, and the token itself is shown once, on create or rotate.
 */
export interface SourceEntry {
  id: string;
  name: string;
  type: "till" | "scale" | "generic";
  /** Base URL for the health probe (`GET <baseUrl>/api/health`). */
  baseUrl?: string;
  lane?: string;
  /** How events arrive. Absent = push. `pull` and `both` need a till with a baseUrl:
   *  the console then reads its sessions and scans every few seconds. */
  mode?: "push" | "pull" | "both";
  tokenHash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
}

/** Convergence status the reconciler writes back after each run. */
export interface ReconcileStatus {
  /** ISO timestamp of the last reconcile run. */
  lastRunAt: string;
  /** Counts applied on the last run. */
  applied: {
    camerasAdded: number;
    camerasPruned: number;
    promptUpdated: boolean;
    scenariosUpdated: boolean;
  };
  /** Human-readable drift notes (desired-vs-live differences observed). */
  drift: string[];
  /** Human-readable errors from the last run (empty = clean). */
  errors: string[];
  /** Agent build identifier, for debugging which agent applied the state. */
  agentVersion: string;
}

/** A zero-valued status stamped at `now`. */
export function emptyStatus(agentVersion: string, now: string): ReconcileStatus {
  return {
    lastRunAt: now,
    applied: { camerasAdded: 0, camerasPruned: 0, promptUpdated: false, scenariosUpdated: false },
    drift: [],
    errors: [],
    agentVersion,
  };
}

/**
 * Store-agnostic config persistence. Covers cameras, status, prompt, and
 * scenarios. The reconciler and the deployer both depend on this interface,
 * never on a concrete store.
 */
export interface ConfigStore {
  readCameras(instance: string): Promise<CameraEntry[]>;
  /**
   * Overwrite the camera list for `instance`. `updatedBy` is stamped into the
   * store for the audit trail (e.g. an operator email, or "reconciler@<version>").
   */
  writeCameras(instance: string, cameras: CameraEntry[], updatedBy: string): Promise<void>;
  /** Add or replace a single camera (atomic single-doc write). */
  upsertCamera(instance: string, camera: CameraEntry, updatedBy: string): Promise<void>;
  /** Remove a single camera by id (atomic single-doc delete). */
  deleteCamera(instance: string, id: string, updatedBy: string): Promise<void>;
  readStatus(instance: string): Promise<ReconcileStatus | null>;
  writeStatus(instance: string, status: ReconcileStatus): Promise<void>;
  /**
   * Resolves the active prompt-set's `{prompt, model}` when set; else the legacy single prompt doc.
   */
  readPrompt(instance: string): Promise<PromptDoc | null>;
  writePrompt(instance: string, prompt: PromptDoc, updatedBy: string): Promise<void>;
  readScenarios(instance: string): Promise<ScenarioEntry[]>;
  writeScenarios(instance: string, scenarios: ScenarioEntry[], updatedBy: string): Promise<void>;
  readPromptSets(instance: string): Promise<PromptSet[]>;
  upsertPromptSet(instance: string, set: PromptSet, updatedBy: string): Promise<void>;
  deletePromptSet(instance: string, id: string, updatedBy: string): Promise<void>;
  readActivePromptId(instance: string): Promise<string | null>;
  setActivePromptId(instance: string, id: string, updatedBy: string): Promise<void>;
  readSources(instance: string): Promise<SourceEntry[]>;
  /** Add or replace a single source. Replaces the whole entity, like upsertCamera. */
  upsertSource(instance: string, source: SourceEntry, updatedBy: string): Promise<void>;
  deleteSource(instance: string, id: string, updatedBy: string): Promise<void>;
}
