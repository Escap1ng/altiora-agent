import { readFileSync } from "node:fs";
import { HarnessError } from "../core/errors.ts";
import { projectConfigFile, resolveAppPaths } from "./paths.ts";
import { DEFAULT_CONFIG, resolveConfig, validateConfig, type Config } from "./schema.ts";

export interface LoadOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string | undefined;
  trustProject?: boolean;
  overrides?: Partial<Config>;
}

export interface LoadedConfig {
  config: Config;
  apiKey: string | undefined;
}

function readConfigFile(path: string, required: boolean): Partial<Config> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new HarnessError(`cannot read config ${path}`, { code: "config", cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HarnessError(`invalid json in config ${path}`, { code: "config", cause: error });
  }
  const problems = validateConfig(parsed);
  if (problems.length > 0) {
    throw new HarnessError(`invalid config ${path}: ${problems.join("; ")}`, { code: "config" });
  }
  return parsed as Partial<Config>;
}

function mergeConfig(base: Config, next: Partial<Config>): Config {
  return {
    ...base,
    ...next,
    tools: next.tools === undefined ? base.tools : { bash: { ...base.tools.bash, ...next.tools.bash } },
    permissions:
      next.permissions === undefined
        ? base.permissions
        : {
            ...base.permissions,
            ...next.permissions,
            rules: next.permissions.rules ?? base.permissions.rules,
          },
    compaction: next.compaction === undefined ? base.compaction : { ...base.compaction, ...next.compaction },
    retry: next.retry === undefined ? base.retry : { ...base.retry, ...next.retry },
    trustedProjects: next.trustedProjects ?? base.trustedProjects,
  };
}

function envOverrides(env: NodeJS.ProcessEnv): Partial<Config> {
  const overrides: Partial<Config> = {};
  if (env.ALTIORA_BASE_URL) overrides.baseUrl = env.ALTIORA_BASE_URL;
  if (env.ALTIORA_MODEL) overrides.model = env.ALTIORA_MODEL;
  if (env.ALTIORA_MAX_STEPS) {
    const steps = Number(env.ALTIORA_MAX_STEPS);
    if (!Number.isInteger(steps) || steps <= 0) {
      throw new HarnessError(`ALTIORA_MAX_STEPS must be a positive integer, got ${env.ALTIORA_MAX_STEPS}`, {
        code: "config",
      });
    }
    overrides.maxSteps = steps;
  }
  if (env.ALTIORA_CONTEXT_WINDOW) {
    const raw = env.ALTIORA_CONTEXT_WINDOW;
    if (raw === "auto") {
      overrides.contextWindow = "auto";
    } else {
      const window = Number(raw);
      if (!Number.isInteger(window) || window <= 0) {
        throw new HarnessError(
          `ALTIORA_CONTEXT_WINDOW must be a positive integer or auto, got ${raw}`,
          { code: "config" },
        );
      }
      overrides.contextWindow = window;
    }
  }
  return overrides;
}

export function loadConfig(options: LoadOptions): LoadedConfig {
  const env = options.env ?? process.env;
  const paths = resolveAppPaths(env);
  const user = readConfigFile(options.configPath ?? paths.configFile, options.configPath !== undefined);

  let config = mergeConfig(DEFAULT_CONFIG, user);

  const projectPath = projectConfigFile(options.cwd);
  if (options.trustProject === true || config.permissions.trustProjectConfig) {
    config = mergeConfig(config, readConfigFile(projectPath, false));
  }

  config = mergeConfig(config, envOverrides(env));
  config = mergeConfig(config, options.overrides ?? {});
  config = resolveConfig(config);

  const apiKey = env[config.apiKeyEnv];
  return { config, apiKey: apiKey === undefined || apiKey === "" ? undefined : apiKey };
}
