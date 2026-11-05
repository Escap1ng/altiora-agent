export type PermissionEffect = "allow" | "ask" | "deny";
export type PermissionMode = "default" | "plan" | "unattended";
export type ShellChoice = "auto" | "pwsh" | "powershell" | "bash" | "sh";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  effect: PermissionEffect;
  source?: "cli" | "project" | "user";
}

export interface BashToolConfig {
  shell: ShellChoice;
  timeoutMs: number;
}

export interface ToolsConfig {
  bash: BashToolConfig;
}

export interface PermissionsConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
  trustProjectConfig: boolean;
}

export interface CompactionConfig {
  enabled: boolean;
  thresholdRatio: number;
  minThresholdTokens: number;
  keepTailTokens: number;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface Config {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  maxSteps: number;
  maxToolCallsPerStep: number;
  maxOutputTokens: number;
  contextWindow: number;
  reserveOutputTokens: number;
  maxOutputChars: number;
  temperature?: number;
  tools: ToolsConfig;
  permissions: PermissionsConfig;
  compaction: CompactionConfig;
  retry: RetryConfig;
  trustedProjects: string[];
}

export const DEFAULT_CONFIG: Config = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  apiKeyEnv: "ALTIORA_API_KEY",
  maxSteps: 40,
  maxToolCallsPerStep: 16,
  maxOutputTokens: 8192,
  contextWindow: 128000,
  reserveOutputTokens: 16000,
  maxOutputChars: 30000,
  tools: {
    bash: {
      shell: "auto",
      timeoutMs: 120000,
    },
  },
  permissions: {
    mode: "default",
    rules: [],
    trustProjectConfig: false,
  },
  compaction: {
    enabled: true,
    thresholdRatio: 0.85,
    minThresholdTokens: 16000,
    keepTailTokens: 15000,
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1000,
  },
  trustedProjects: [],
};

export function resolveConfig(partial: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    tools: {
      ...DEFAULT_CONFIG.tools,
      ...partial.tools,
      bash: {
        ...DEFAULT_CONFIG.tools.bash,
        ...partial.tools?.bash,
      },
    },
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      ...partial.permissions,
      rules: partial.permissions?.rules ?? DEFAULT_CONFIG.permissions.rules,
    },
    compaction: {
      ...DEFAULT_CONFIG.compaction,
      ...partial.compaction,
    },
    retry: {
      ...DEFAULT_CONFIG.retry,
      ...partial.retry,
    },
    trustedProjects: partial.trustedProjects ?? DEFAULT_CONFIG.trustedProjects,
  };
}

const PERMISSION_MODES: ReadonlySet<string> = new Set(["default", "plan", "unattended"]);
const PERMISSION_EFFECTS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);
const SHELLS: ReadonlySet<string> = new Set(["auto", "pwsh", "powershell", "bash", "sh"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function validateConfig(input: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(input)) return ["config must be a JSON object"];

  for (const key of ["provider", "baseUrl", "model", "apiKeyEnv"] as const) {
    const value = input[key];
    if (value !== undefined && typeof value !== "string") {
      problems.push(`${key} must be a string`);
    }
  }
  if (typeof input["baseUrl"] === "string" && !/^https?:\/\//.test(input["baseUrl"])) {
    problems.push("baseUrl must start with http:// or https://");
  }
  for (const key of ["maxSteps", "maxToolCallsPerStep", "maxOutputTokens", "contextWindow", "maxOutputChars"] as const) {
    const value = input[key];
    if (value !== undefined && !isPositiveInteger(value)) {
      problems.push(`${key} must be a positive integer`);
    }
  }

  const tools = input["tools"];
  if (tools !== undefined) {
    if (!isRecord(tools)) {
      problems.push("tools must be an object");
    } else {
      const bash = tools["bash"];
      if (bash !== undefined) {
        if (!isRecord(bash)) {
          problems.push("tools.bash must be an object");
        } else {
          const shell = bash["shell"];
          if (shell !== undefined && (typeof shell !== "string" || !SHELLS.has(shell))) {
            problems.push(`tools.bash.shell must be one of ${[...SHELLS].join(", ")}`);
          }
          const timeoutMs = bash["timeoutMs"];
          if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) {
            problems.push("tools.bash.timeoutMs must be a positive integer");
          }
        }
      }
    }
  }

  const permissions = input["permissions"];
  if (permissions !== undefined) {
    if (!isRecord(permissions)) {
      problems.push("permissions must be an object");
    } else {
      const mode = permissions["mode"];
      if (mode !== undefined && (typeof mode !== "string" || !PERMISSION_MODES.has(mode))) {
        problems.push(`permissions.mode must be one of ${[...PERMISSION_MODES].join(", ")}`);
      }
      const rules = permissions["rules"];
      if (rules !== undefined) {
        if (!Array.isArray(rules)) {
          problems.push("permissions.rules must be an array");
        } else {
          rules.forEach((rule, index) => {
            if (!isRecord(rule)) {
              problems.push(`permissions.rules[${index}] must be an object`);
              return;
            }
            if (typeof rule["tool"] !== "string" || rule["tool"] === "") {
              problems.push(`permissions.rules[${index}].tool must be a non-empty string`);
            }
            const effect = rule["effect"];
            if (typeof effect !== "string" || !PERMISSION_EFFECTS.has(effect)) {
              problems.push(`permissions.rules[${index}].effect must be one of ${[...PERMISSION_EFFECTS].join(", ")}`);
            }
            const pattern = rule["pattern"];
            if (pattern !== undefined && typeof pattern !== "string") {
              problems.push(`permissions.rules[${index}].pattern must be a string`);
            }
          });
        }
      }
    }
  }

  return problems;
}
