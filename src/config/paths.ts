import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppPaths {
  configDir: string;
  configFile: string;
  memoryFile: string;
  dataDir: string;
  sessionsDir: string;
}

export interface PathEnv {
  HOME?: string | undefined;
  USERPROFILE?: string | undefined;
  APPDATA?: string | undefined;
  LOCALAPPDATA?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
  ALTIORA_CONFIG_DIR?: string | undefined;
  ALTIORA_DATA_DIR?: string | undefined;
}

export function resolveAppPaths(
  env: PathEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AppPaths {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const isWindows = platform === "win32";
  const configDir =
    env.ALTIORA_CONFIG_DIR ??
    (isWindows
      ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "altiora")
      : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "altiora"));
  const dataDir =
    env.ALTIORA_DATA_DIR ??
    (isWindows
      ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "altiora")
      : join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "altiora"));

  return {
    configDir,
    configFile: join(configDir, "config.json"),
    memoryFile: join(configDir, "AGENTS.md"),
    dataDir,
    sessionsDir: join(dataDir, "sessions"),
  };
}

export function projectConfigFile(cwd: string): string {
  return join(resolve(cwd), ".altiora", "config.json");
}

export function sessionBucket(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function sessionDirFor(
  cwd: string,
  paths: AppPaths = resolveAppPaths(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(paths.sessionsDir, sessionBucket(cwd, platform));
}
