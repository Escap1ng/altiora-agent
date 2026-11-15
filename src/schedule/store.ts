import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  enabled: boolean;
  allow: string[];
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastSessionId?: string;
  lastError?: string;
  nextRunAt?: number | undefined;
}

export interface ScheduleFile {
  version: 1;
  entries: ScheduleEntry[];
}

export function schedulesPath(dataDir: string): string {
  return join(dataDir, "schedules.json");
}

export function loadSchedules(dataDir: string): ScheduleEntry[] {
  const path = schedulesPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ScheduleFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => typeof entry.id === "string" && typeof entry.cron === "string");
  } catch {
    return [];
  }
}

export function saveSchedules(dataDir: string, entries: ScheduleEntry[]): void {
  const path = schedulesPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, entries } satisfies ScheduleFile, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function newScheduleId(): string {
  return `sch_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}