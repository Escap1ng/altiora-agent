import { mkdirSync } from "node:fs";
import { Writable } from "node:stream";
import { buildRuntime, prepareSession } from "../cli/runtime.ts";
import { sessionDirFor, resolveAppPaths } from "../config/paths.ts";
import { runAgent } from "../core/loop.ts";
import { toHarnessError } from "../core/errors.ts";
import { nextRun } from "./cron.ts";
import { loadSchedules, saveSchedules, type ScheduleEntry } from "./store.ts";

export interface SchedulerOptions {
  env: NodeJS.ProcessEnv;
  version: string;
  intervalMs?: number;
  onRun?: (entry: ScheduleEntry, ok: boolean, detail: string) => void;
}

export interface RunOutcome {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

const silent = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export async function runScheduleEntry(entry: ScheduleEntry, options: SchedulerOptions): Promise<RunOutcome> {
  const built = await buildRuntime(
    { cwd: entry.cwd, env: options.env, stderr: silent, version: options.version },
    { "permission-mode": "unattended", allow: entry.allow },
  );
  if (!built.ok) return { ok: false, error: "cannot build runtime (missing model or api key?)" };
  const { config, provider, registry, subagentRegistry, permissions, systemPrompt, estimator, contextWindow } =
    built.runtime;

  const directory = sessionDirFor(entry.cwd, resolveAppPaths(options.env));
  mkdirSync(directory, { recursive: true });
  const session = prepareSession({
    directory,
    cwd: entry.cwd,
    model: config.model,
    version: options.version,
    resumeId: undefined,
    forkId: undefined,
  });

  const controller = new AbortController();
  try {
    const result = await runAgent(entry.prompt, {
      provider,
      registry,
      permissions,
      model: config.model,
      cwd: entry.cwd,
      platform: process.platform,
      signal: controller.signal,
      maxSteps: config.maxSteps,
      maxToolCallsPerStep: config.maxToolCallsPerStep,
      maxOutputChars: config.maxOutputChars,
      bash: config.tools.bash,
      retry: config.retry,
      turn: session.turn,
      log: session.log,
      systemPrompt,
      estimator,
      compaction: config.compaction,
      contextWindow,
      reserveOutputTokens: config.reserveOutputTokens,
      runSubagent: async (prompt) => {
        const nested = await runAgent(prompt, {
          provider,
          registry: subagentRegistry,
          permissions,
          model: config.model,
          cwd: entry.cwd,
          platform: process.platform,
          signal: controller.signal,
          maxSteps: Math.min(config.maxSteps, 20),
          maxToolCallsPerStep: config.maxToolCallsPerStep,
          maxOutputChars: config.maxOutputChars,
          bash: config.tools.bash,
          retry: config.retry,
          systemPrompt,
        });
        return { text: nested.text, isError: nested.stopReason !== "completed" };
      },
    });
    const ok = result.stopReason === "completed";
    return ok ? { ok, sessionId: session.id } : { ok: false, sessionId: session.id, error: result.stopReason };
  } catch (error) {
    return { ok: false, sessionId: session.id, error: toHarnessError(error, "provider").message };
  }
}

export function recomputeNext(entry: ScheduleEntry, now: number): ScheduleEntry {
  try {
    return { ...entry, nextRunAt: nextRun(entry.cron, new Date(now)).getTime() };
  } catch {
    return { ...entry, nextRunAt: undefined };
  }
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();
  private readonly dataDir: string;
  private readonly options: SchedulerOptions;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.dataDir = resolveAppPaths(options.env).dataDir;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 15000);
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): ScheduleEntry[] {
    return loadSchedules(this.dataDir);
  }

  async runNow(id: string): Promise<RunOutcome> {
    const entries = this.list();
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return { ok: false, error: `schedule not found: ${id}` };
    return this.execute(entry);
  }

  async tick(now: number = Date.now()): Promise<void> {
    const entries = this.list();
    let changed = false;
    const updated: ScheduleEntry[] = [];
    for (const entry of entries) {
      if (!entry.enabled) {
        updated.push(entry);
        continue;
      }
      const due = entry.nextRunAt !== undefined && entry.nextRunAt <= now;
      if (due && !this.running.has(entry.id)) {
        changed = true;
        const outcome = await this.execute(entry);
        updated.push(
          recomputeNext(
            {
              ...entry,
              lastRunAt: now,
              lastStatus: outcome.ok ? "ok" : "error",
              ...(outcome.sessionId === undefined ? {} : { lastSessionId: outcome.sessionId }),
              ...(outcome.error === undefined ? {} : { lastError: outcome.error }),
            },
            now,
          ),
        );
      } else {
        updated.push(entry.nextRunAt === undefined ? recomputeNext(entry, now) : entry);
        if (entry.nextRunAt === undefined) changed = true;
      }
    }
    if (changed) saveSchedules(this.dataDir, updated);
  }

  private async execute(entry: ScheduleEntry): Promise<RunOutcome> {
    this.running.add(entry.id);
    try {
      const outcome = await runScheduleEntry(entry, this.options);
      this.options.onRun?.(entry, outcome.ok, outcome.error ?? "");
      return outcome;
    } finally {
      this.running.delete(entry.id);
    }
  }
}