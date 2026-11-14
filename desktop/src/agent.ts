import { mkdirSync } from "node:fs";
import { Writable } from "node:stream";
import { sessionDirFor, resolveAppPaths } from "../core-dist/config/paths.js";
import { buildRuntime, prepareSession, type Runtime, type SessionSetup } from "../core-dist/cli/runtime.js";
import { toHarnessError } from "../core-dist/core/errors.js";
import { runAgent, type RunEvent, type StopReason } from "../core-dist/core/loop.js";
import type { Message, Usage } from "../core-dist/core/types.js";
import { deriveMessages } from "../core-dist/session/derive.js";
import { listSessions, type SessionSummary } from "../core-dist/session/store.js";

export interface ReadyState {
  workspace: string;
  model: string;
  contextWindow: number;
  contextWindowSource: "config" | "models" | "fallback";
  sessionId: string;
  permissionMode: string;
  version: string;
}

export interface ConfirmRequest {
  id: string;
  tool: string;
  resources: string[];
  reason: string;
}

export interface AgentOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
  send: (channel: string, payload: unknown) => void;
}

export type RunOutcome = { ok: true; stopReason: StopReason } | { ok: false; message: string };

export type OpenOutcome =
  | { ok: true; sessionId: string; history: Message[] }
  | { ok: false; message: string };

export class AgentService {
  private readonly options: AgentOptions;
  private readonly runtime: Runtime;
  private session: SessionSetup;
  private history: Message[];
  private turn: number;
  private running: AbortController | undefined;
  private confirmSeq = 0;
  private readonly pendingConfirms = new Map<string, (approved: boolean) => void>();

  private constructor(options: AgentOptions, runtime: Runtime, session: SessionSetup) {
    this.options = options;
    this.runtime = runtime;
    this.session = session;
    this.history = session.history ?? [];
    this.turn = session.turn;
  }

  static async create(options: AgentOptions): Promise<AgentService> {
    let stderr = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        stderr += String(chunk);
        callback();
      },
    });
    const built = await buildRuntime(
      { cwd: options.cwd, env: options.env, stderr: sink, version: options.version },
      {},
    );
    if (!built.ok) throw new Error(stderr.trim() || "cannot start the agent runtime");

    const directory = AgentService.directoryFor(options);
    mkdirSync(directory, { recursive: true });
    const session = prepareSession({
      directory,
      cwd: options.cwd,
      model: built.runtime.config.model,
      version: options.version,
      resumeId: undefined,
      forkId: undefined,
    });
    return new AgentService(options, built.runtime, session);
  }

  private static directoryFor(options: AgentOptions): string {
    return sessionDirFor(options.cwd, resolveAppPaths(options.env));
  }

  state(): ReadyState {
    return {
      workspace: this.options.cwd,
      model: this.runtime.config.model,
      contextWindow: this.runtime.contextWindow,
      contextWindowSource: this.runtime.contextWindowSource,
      sessionId: this.session.id,
      permissionMode: this.runtime.mode,
      version: this.options.version,
    };
  }

  isRunning(): boolean {
    return this.running !== undefined;
  }

  setMode(mode: "default" | "plan" | "unattended"): void {
    this.runtime.permissions.setMode(mode);
    this.runtime.mode = mode;
  }

  sessions(): SessionSummary[] {
    return listSessions(AgentService.directoryFor(this.options));
  }

  abort(): void {
    this.running?.abort();
    this.resolveAllConfirms(false);
  }

  resolveConfirm(id: string, approved: boolean): boolean {
    const resolve = this.pendingConfirms.get(id);
    if (resolve === undefined) return false;
    this.pendingConfirms.delete(id);
    resolve(approved);
    return true;
  }

  async openSession(id: string): Promise<OpenOutcome> {
    if (this.running !== undefined) return { ok: false, message: "stop the current turn first" };
    try {
      const setup = prepareSession({
        directory: AgentService.directoryFor(this.options),
        cwd: this.options.cwd,
        model: this.runtime.config.model,
        version: this.options.version,
        resumeId: id,
        forkId: undefined,
      });
      this.session = setup;
      this.history = setup.history ?? [];
      this.turn = setup.turn;
      return {
        ok: true,
        sessionId: setup.id,
        history: deriveMessages(setup.log.records()).messages,
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  newSession(): OpenOutcome {
    if (this.running !== undefined) return { ok: false, message: "stop the current turn first" };
    const setup = prepareSession({
      directory: AgentService.directoryFor(this.options),
      cwd: this.options.cwd,
      model: this.runtime.config.model,
      version: this.options.version,
      resumeId: undefined,
      forkId: undefined,
    });
    this.session = setup;
    this.history = [];
    this.turn = setup.turn;
    return { ok: true, sessionId: setup.id, history: [] };
  }

  async run(prompt: string): Promise<RunOutcome> {
    if (this.running !== undefined) return { ok: false, message: "a turn is already running" };
    const controller = new AbortController();
    this.running = controller;

    const {
      provider,
      registry,
      subagentRegistry,
      permissions,
      systemPrompt,
      estimator,
      config,
      contextWindow,
    } = this.runtime;

    try {
      const result = await runAgent(prompt, {
        provider,
        registry,
        permissions,
        model: config.model,
        cwd: this.options.cwd,
        platform: process.platform,
        signal: controller.signal,
        maxSteps: config.maxSteps,
        maxToolCallsPerStep: config.maxToolCallsPerStep,
        maxOutputChars: config.maxOutputChars,
        bash: config.tools.bash,
        retry: config.retry,
        ...(this.history.length === 0 ? {} : { history: this.history }),
        turn: this.turn,
        log: this.session.log,
        systemPrompt,
        estimator,
        compaction: config.compaction,
        contextWindow,
        reserveOutputTokens: config.reserveOutputTokens,
        confirm: (request) => this.askConfirm(request),
        runSubagent: async (subPrompt: string) => {
          const nested = await runAgent(subPrompt, {
            provider,
            registry: subagentRegistry,
            permissions,
            model: config.model,
            cwd: this.options.cwd,
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
        onEvent: (event: RunEvent) => this.options.send("altiora:event", event),
      });

      this.history = result.messages;
      this.turn += 1;
      this.options.send("altiora:run-finished", {
        stopReason: result.stopReason,
        usage: result.usage,
      } satisfies { stopReason: StopReason; usage: Usage });
      return { ok: true, stopReason: result.stopReason };
    } catch (error) {
      const failure = toHarnessError(error, "provider");
      this.history = [...this.history, { role: "user", content: prompt }];
      this.options.send("altiora:run-error", { message: failure.message, code: failure.code });
      return { ok: false, message: failure.message };
    } finally {
      this.running = undefined;
      this.resolveAllConfirms(false);
    }
  }

  private askConfirm(request: { tool: string; resources: string[]; reason: string }): Promise<boolean> {
    const id = `confirm-${++this.confirmSeq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingConfirms.set(id, resolve);
      this.options.send("altiora:confirm-request", {
        id,
        tool: request.tool,
        resources: request.resources,
        reason: request.reason,
      } satisfies ConfirmRequest);
    });
  }

  private resolveAllConfirms(approved: boolean): void {
    for (const [id, resolve] of this.pendingConfirms) {
      this.pendingConfirms.delete(id);
      resolve(approved);
    }
  }
}
