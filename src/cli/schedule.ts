import { resolveAppPaths } from "../config/paths.ts";
import { nextRun } from "../schedule/cron.ts";
import { Scheduler, recomputeNext } from "../schedule/scheduler.ts";
import { loadSchedules, newScheduleId, saveSchedules, type ScheduleEntry } from "../schedule/store.ts";

export interface ScheduleIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  version: string;
}

function dataDir(io: ScheduleIo): string {
  return resolveAppPaths(io.env).dataDir;
}

function writeList(io: ScheduleIo, entries: ScheduleEntry[]): void {
  if (entries.length === 0) {
    io.stdout.write("(no schedules)\n");
    return;
  }
  for (const entry of entries) {
    const next = entry.nextRunAt === undefined ? "-" : new Date(entry.nextRunAt).toISOString();
    const last = entry.lastRunAt === undefined ? "-" : `${new Date(entry.lastRunAt).toISOString()} ${entry.lastStatus ?? ""}`;
    io.stdout.write(
      `${entry.id}  ${entry.enabled ? "on " : "off"}  ${entry.cron}  next=${next}  last=${last}  ${entry.name}\n`,
    );
  }
}

export async function scheduleCommand(argv: string[], io: ScheduleIo): Promise<number> {
  const sub = argv[0];
  const dir = dataDir(io);

  if (sub === undefined || sub === "list") {
    writeList(io, loadSchedules(dir));
    return 0;
  }

  if (sub === "add") {
    const name = argv[1];
    const cron = argv[2];
    const prompt = argv.slice(3).join(" ").trim();
    if (name === undefined || cron === undefined || prompt === "") {
      io.stderr.write("usage: altiora schedule add <name> <cron> <prompt> [--allow rule]...\n");
      return 2;
    }
    try {
      nextRun(cron, new Date());
    } catch (error) {
      io.stderr.write(`${(error as Error).message}\n`);
      return 2;
    }
    const allow: string[] = [];
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--allow" && argv[i + 1] !== undefined) {
        allow.push(argv[i + 1]!);
        i++;
      }
    }
    const entry = recomputeNext(
      {
        id: newScheduleId(),
        name,
        cron,
        prompt,
        cwd: io.cwd,
        enabled: true,
        allow,
        createdAt: Date.now(),
      },
      Date.now(),
    );
    saveSchedules(dir, [...loadSchedules(dir), entry]);
    io.stdout.write(`${entry.id}\n`);
    return 0;
  }

  if (sub === "remove") {
    const id = argv[1];
    if (id === undefined) {
      io.stderr.write("usage: altiora schedule remove <id>\n");
      return 2;
    }
    const entries = loadSchedules(dir);
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) {
      io.stderr.write(`schedule not found: ${id}\n`);
      return 1;
    }
    saveSchedules(dir, next);
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    const id = argv[1];
    if (id === undefined) {
      io.stderr.write(`usage: altiora schedule ${sub} <id>\n`);
      return 2;
    }
    const entries = loadSchedules(dir);
    const target = entries.find((entry) => entry.id === id);
    if (target === undefined) {
      io.stderr.write(`schedule not found: ${id}\n`);
      return 1;
    }
    target.enabled = sub === "enable";
    saveSchedules(dir, entries.map((entry) => (entry.id === id ? recomputeNext(target, Date.now()) : entry)));
    return 0;
  }

  if (sub === "run-now") {
    const id = argv[1];
    if (id === undefined) {
      io.stderr.write("usage: altiora schedule run-now <id>\n");
      return 2;
    }
    const scheduler = new Scheduler({ env: io.env, version: io.version });
    const outcome = await scheduler.runNow(id);
    if (!outcome.ok) {
      io.stderr.write(`${outcome.error ?? "run failed"}\n`);
      return 1;
    }
    io.stdout.write(`${outcome.sessionId ?? ""}\n`);
    return 0;
  }

  if (sub === "watch") {
    const scheduler = new Scheduler({
      env: io.env,
      version: io.version,
      onRun: (entry, ok, detail) => {
        io.stdout.write(`[schedule] ${entry.name} ${ok ? "ok" : `error: ${detail}`}\n`);
      },
    });
    scheduler.start();
    io.stderr.write("watching schedules (ctrl+c to stop)\n");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => {
        scheduler.stop();
        resolve();
      });
    });
    return 0;
  }

  io.stderr.write(`unknown schedule subcommand: ${sub}\n`);
  return 2;
}