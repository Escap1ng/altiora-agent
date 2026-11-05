import { spawn } from "node:child_process";
import type { ShellChoice } from "../config/schema.ts";
import { resolveShellChoice } from "./registry.ts";

export interface ShellResult {
  output: string;
  exitCode: number | null;
  aborted: boolean;
  timedOut: boolean;
}

const SHELLS: Record<Exclude<ShellChoice, "auto">, { command: string; args: string[] }> = {
  powershell: { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "-"] },
  pwsh: { command: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", "-"] },
  bash: { command: "bash", args: ["--noprofile", "--norc", "-s"] },
  sh: { command: "sh", args: ["-s"] },
};

export interface ShellOptions {
  command: string;
  cwd: string;
  platform: NodeJS.Platform;
  shell: ShellChoice;
  timeoutMs: number;
  signal: AbortSignal;
}

export function runShell(options: ShellOptions): Promise<ShellResult> {
  const choice = resolveShellChoice(options.shell, options.platform) as Exclude<ShellChoice, "auto">;
  const spec = SHELLS[choice];
  const script =
    choice === "powershell" || choice === "pwsh"
      ? `${options.command}\nexit $LASTEXITCODE\n`
      : options.command;

  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: options.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (options.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({ output: [stdout, stderr].filter((part) => part !== "").join(""), exitCode, aborted, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(script);
  });
}
