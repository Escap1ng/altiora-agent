import { posix, win32 } from "node:path";
import { HarnessError } from "../core/errors.ts";

function pathsFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function fold(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function isInside(cwd: string, absolute: string, platform: NodeJS.Platform): boolean {
  const paths = pathsFor(platform);
  const relative = paths.relative(fold(cwd, platform), fold(absolute, platform));
  return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
}

export function resolveInside(cwd: string, target: string, platform: NodeJS.Platform): string {
  const paths = pathsFor(platform);
  const absolute = paths.resolve(cwd, target);
  if (!isInside(cwd, absolute, platform)) {
    throw new HarnessError(`path escapes the workspace: ${target}`, { code: "bad_request" });
  }
  return absolute;
}

export function displayPath(cwd: string, absolute: string, platform: NodeJS.Platform): string {
  const paths = pathsFor(platform);
  const relative = paths.relative(cwd, absolute);
  return (relative === "" ? "." : relative).replace(/\\/g, "/");
}
