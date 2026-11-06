import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionPath } from "./log.ts";
import { parseRecords } from "./records.ts";

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  model: string;
  updatedAt: number;
  records: number;
}

export function listSessions(directory: string): SessionSummary[] {
  if (!existsSync(directory)) return [];
  const summaries: SessionSummary[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    const path = join(directory, name);
    const records = parseRecords(readFileSync(path, "utf8"));
    const start = records.find((record) => record.t === "session/start");
    summaries.push({
      id,
      path,
      cwd: start !== undefined && start.t === "session/start" ? start.cwd : "",
      model: start !== undefined && start.t === "session/start" ? start.model : "",
      updatedAt: statSync(path).mtimeMs,
      records: records.length,
    });
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function latestSession(directory: string): SessionSummary | undefined {
  return listSessions(directory)[0];
}

export function resolveSessionPath(directory: string, id: string): string {
  return sessionPath(directory, id);
}
