import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RECORD_VERSION, parseRecords, type Rec } from "./records.ts";

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  provider: string;
  harnessVersion: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewRecord = DistributiveOmit<Rec, "v" | "ts">;

export class SessionLog {
  readonly id: string;
  readonly path: string;

  constructor(id: string, path: string) {
    this.id = id;
    this.path = path;
  }

  append(record: NewRecord): void {
    appendFileSync(this.path, `${JSON.stringify({ v: RECORD_VERSION, ts: Date.now(), ...record })}\n`, "utf8");
  }

  records(): Rec[] {
    if (!existsSync(this.path)) return [];
    return parseRecords(readFileSync(this.path, "utf8"));
  }
}

export function sessionPath(directory: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid session id: ${id}`);
  }
  return join(directory, `${id}.jsonl`);
}

export function openSession(directory: string, id: string): SessionLog {
  return new SessionLog(id, sessionPath(directory, id));
}
