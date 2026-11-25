import { spawn } from "node:child_process";
import { encodeFrame, parseFrames, type FrameResult, type JsonRpcMessage } from "./frames.ts";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
}

export interface TransportExit {
  code: number | null;
  signal: string | null;
  stderr: string;
  error: string | null;
}

export interface StdioTransport {
  pid: number | undefined;
  send(message: JsonRpcMessage): boolean;
  frames(): AsyncGenerator<FrameResult>;
  close(): void;
  exited: Promise<TransportExit>;
}

const STDERR_LIMIT = 8192;

export function startStdioTransport(options: StdioTransportOptions): StdioTransport {
  const platform = options.platform ?? process.platform;
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: platform !== "win32",
  });

  let stderr = "";
  let spawnError: string | null = null;
  let closed = false;

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
  });
  child.stdin.on("error", () => undefined);

  const killTree = (): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  const exited = new Promise<TransportExit>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stderr, error: spawnError });
    };
    child.on("error", (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });

  return {
    pid: child.pid,
    send(message) {
      if (closed || child.stdin.destroyed) return false;
      child.stdin.write(encodeFrame(message));
      return true;
    },
    async *frames() {
      if (child.stdout === null) return;
      yield* parseFrames(child.stdout);
    },
    close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      killTree();
    },
    exited,
  };
}