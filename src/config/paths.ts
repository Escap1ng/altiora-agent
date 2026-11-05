import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

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

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

export function resolveAppPaths(
  env: PathEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AppPaths {
  const p = pathFor(platform);
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const isWindows = platform === "win32";
  const configDir =
    env.ALTIORA_CONFIG_DIR ??
    (isWindows
      ? p.join(env.APPDATA ?? p.join(home, "AppData", "Roaming"), "altiora")
      : p.join(env.XDG_CONFIG_HOME ?? p.join(home, ".config"), "altiora"));
  const dataDir =
    env.ALTIORA_DATA_DIR ??
    (isWindows
      ? p.join(env.LOCALAPPDATA ?? p.join(home, "AppData", "Local"), "altiora")
      : p.join(env.XDG_DATA_HOME ?? p.join(home, ".local", "share"), "altiora"));

  return {
    configDir,
    configFile: p.join(configDir, "config.json"),
    memoryFile: p.join(configDir, "AGENTS.md"),
    dataDir,
    sessionsDir: p.join(dataDir, "sessions"),
  };
}

export function projectConfigFile(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  return p.join(p.resolve(cwd), ".altiora", "config.json");
}

export function sessionBucket(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  const normalized = platform === "win32" ? p.resolve(cwd).toLowerCase() : p.resolve(cwd);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function sessionDirFor(
  cwd: string,
  paths: AppPaths = resolveAppPaths(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(paths.sessionsDir, sessionBucket(cwd, platform));
}
