import { posix, win32 } from "node:path";
import type { PermissionEffect, PermissionRule } from "../config/schema.ts";
import { globToRegExp, normalizePath } from "../util/glob.ts";

export interface Rule extends PermissionRule {
  id: string;
}

export function matchesResource(
  pattern: string,
  resource: string,
  cwd: string,
  platform: NodeJS.Platform,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const fold = (value: string): string =>
    normalizePath(platform === "win32" ? value.toLowerCase() : value);
  const expression = globToRegExp(pattern, platform);
  const candidate = fold(resource);
  if (expression.test(candidate)) return true;

  const relativePath = paths.relative(cwd, resource);
  if (relativePath !== "" && !relativePath.startsWith("..") && !paths.isAbsolute(relativePath)) {
    if (expression.test(fold(relativePath))) return true;
  }

  if (!paths.isAbsolute(pattern)) {
    const absolute = paths.resolve(cwd, pattern);
    if (expression.test(fold(absolute))) return true;
  }
  return false;
}

export function parseRuleString(value: string, effect: PermissionEffect, id: string): Rule {
  const match = /^([A-Za-z0-9_-]+)(?:\((.*)\))?$/.exec(value.trim());
  if (match === null) {
    throw new Error(`invalid permission rule: ${value}`);
  }
  const tool = match[1]!;
  const pattern = match[2];
  return pattern === undefined || pattern === ""
    ? { id, tool, effect, source: "cli" }
    : { id, tool, pattern, effect, source: "cli" };
}

export function normalizeRules(rules: PermissionRule[]): Rule[] {
  return rules.map((rule, index) => ({
    ...rule,
    source: rule.source ?? "user",
    id: `${index}`,
  }));
}
