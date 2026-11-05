import type { ShellChoice, ToolsConfig } from "../config/schema.ts";
import type { ToolDeclaration } from "../core/types.ts";
import { HarnessError } from "../core/errors.ts";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolContext {
  cwd: string;
  platform: NodeJS.Platform;
  signal: AbortSignal;
  maxOutputChars: number;
  bash: ToolsConfig["bash"];
  todos: TodoItem[];
}

export interface ToolResult {
  output: string;
  isError: boolean;
  truncated: boolean;
}

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  parameters: object;
  readOnly?: boolean;
  parse(input: unknown): I;
  resources?(input: I, context: ToolContext): string[];
  execute(input: I, context: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  get(name: string): ToolDefinition | undefined;
  declarations(): ToolDeclaration[];
  names(): string[];
  isReadOnly(name: string): boolean;
}

export function createRegistry(tools: ToolDefinition[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    get: (name) => byName.get(name),
    declarations: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    names: () => tools.map((tool) => tool.name),
    isReadOnly: (name) => byName.get(name)?.readOnly === true,
  };
}

export function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessError("tool input must be an object", { code: "bad_request" });
  }
  return input as Record<string, unknown>;
}

export function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new HarnessError(`${field} must be a string`, { code: "bad_request" });
  }
  return value;
}

export function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HarnessError(`${field} must be a string`, { code: "bad_request" });
  }
  return value;
}

export function optionalNumber(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HarnessError(`${field} must be a number`, { code: "bad_request" });
  }
  return value;
}

export function optionalBoolean(input: Record<string, unknown>, field: string): boolean | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new HarnessError(`${field} must be a boolean`, { code: "bad_request" });
  }
  return value;
}

export function resolveShellChoice(choice: ShellChoice, platform: NodeJS.Platform): ShellChoice {
  if (choice !== "auto") return choice;
  return platform === "win32" ? "powershell" : "sh";
}
