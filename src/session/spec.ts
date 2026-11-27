import { createHash } from "node:crypto";
import type { Config } from "../config/schema.ts";

export interface HarnessSpec {
  toolNames: string[];
  configFingerprint: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function fingerprintConfig(config: Config): string {
  return digest(JSON.stringify(canonical(config)));
}

export function inputFingerprint(text: string): string {
  return digest(text);
}
