"use client";

import * as React from "react";
import type { Scenario } from "@/lib/types";
import { TableCell, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Copy } from "lucide-react";
import { KeywordChips } from "./KeywordChips";
import { SensorFilterInput } from "./SensorFilterInput";
import { MultiCameraConfig, type PurchaseStatusView } from "./MultiCameraConfig";
import { DEFAULT_RULES } from "@/lib/purchase-judge";

interface ScenarioRowProps {
  scenario: Scenario;
  onChange: (updated: Scenario) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** Pickable ids for the multi-camera form. */
  cameraIds?: string[];
  sourceIds?: string[];
  purchaseStatus?: PurchaseStatusView;
}

const CHANNELS: Array<"ui" | "slack"> = ["ui", "slack"];
const COLUMNS = 8;

export function ScenarioRow({
  scenario,
  onChange,
  onDelete,
  onDuplicate,
  cameraIds = [],
  sourceIds = [],
  purchaseStatus,
}: ScenarioRowProps) {
  const multi = scenario.mode === "multi";
  const setMode = (mode: string) =>
    onChange(
      mode === "multi"
        ? {
            ...scenario,
            mode: "multi",
            cameras: scenario.cameras ?? [],
            sources: scenario.sources ?? [],
            rules: scenario.rules ?? DEFAULT_RULES,
          }
        : (({ mode: _m, cameras: _c, sources: _s, rules: _r, productClasses: _p, ...rest }) => rest)(scenario),
    );
  const update = <K extends keyof Scenario>(key: K, value: Scenario[K]) => {
    onChange({ ...scenario, [key]: value });
  };

  const toggleChannel = (ch: "ui" | "slack") => {
    const has = scenario.channels.includes(ch);
    update(
      "channels",
      has
        ? scenario.channels.filter((c) => c !== ch)
        : [...scenario.channels, ch]
    );
  };

  return (
    <>
    <TableRow className={multi ? "border-b-0" : undefined}>
      <TableCell className="w-12">
        <Switch
          checked={scenario.enabled}
          onCheckedChange={(v) => update("enabled", v)}
        />
      </TableCell>
      <TableCell className="min-w-[240px] space-y-1">
        <Input
          value={scenario.name}
          onChange={(e) => update("name", e.target.value)}
          className="h-8 text-sm"
          placeholder="Scenario name"
        />
        <select
          aria-label="Mode"
          value={multi ? "multi" : "single"}
          onChange={(e) => setMode(e.target.value)}
          className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs"
          title="Single camera: each camera alerts on its own. Multi-camera: cameras work together, one incident per till purchase."
        >
          <option value="single">Single camera</option>
          <option value="multi">Multi-camera (one incident per purchase)</option>
        </select>
      </TableCell>
      <TableCell className="min-w-[200px]">
        <KeywordChips
          keywords={scenario.keywords}
          onChange={(kw) => update("keywords", kw)}
        />
      </TableCell>
      <TableCell className="min-w-[180px]">
        <SensorFilterInput
          value={scenario.sensorFilter}
          onChange={(v) => update("sensorFilter", v)}
        />
      </TableCell>
      <TableCell>
        <Select
          value={scenario.severity}
          onValueChange={(v) => update("severity", v as Scenario["severity"])}
        >
          <SelectTrigger className="h-8 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">low</SelectItem>
            <SelectItem value="medium">medium</SelectItem>
            <SelectItem value="high">high</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          {CHANNELS.map((ch) => (
            <label key={ch} className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                className="accent-primary"
                checked={scenario.channels.includes(ch)}
                onChange={() => toggleChannel(ch)}
              />
              <span className="text-xs">{ch}</span>
            </label>
          ))}
          <label
            className="flex items-center gap-1 cursor-pointer"
            title="Seal this scenario's incident clips into ARTESCA Object Lock (WORM / immutable evidence)"
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={!!scenario.immutable?.enabled}
              onChange={(e) =>
                update("immutable", {
                  enabled: e.target.checked,
                  retentionDays: scenario.immutable?.retentionDays ?? 365,
                  mode: scenario.immutable?.mode ?? "COMPLIANCE",
                })
              }
            />
            <span className="text-xs">🔒 lock</span>
          </label>
          {scenario.immutable?.enabled && (
            <input
              type="number"
              min={1}
              max={3650}
              className="h-6 w-16 rounded border border-input bg-background px-1 text-xs"
              value={scenario.immutable.retentionDays}
              onChange={(e) =>
                update("immutable", {
                  enabled: true,
                  retentionDays: Number(e.target.value) || 365,
                  mode: scenario.immutable?.mode ?? "COMPLIANCE",
                })
              }
              title="Retention (days)"
            />
          )}
        </div>
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min={0}
          className="h-8 w-20 text-xs"
          placeholder="120"
          value={scenario.cooldownSeconds ?? ""}
          onChange={(e) =>
            update(
              "cooldownSeconds",
              e.target.value === "" ? undefined : Number(e.target.value)
            )
          }
          title="Cooldown override (seconds)"
        />
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onDuplicate}
            title="Duplicate"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
    {multi && (
      <TableRow>
        <TableCell colSpan={COLUMNS} className="pt-0">
          <MultiCameraConfig
            scenario={scenario}
            onChange={onChange}
            cameraIds={cameraIds}
            sourceIds={sourceIds}
            status={purchaseStatus}
          />
        </TableCell>
      </TableRow>
    )}
    </>
  );
}
