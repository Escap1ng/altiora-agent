import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { expandImports } from "../config/memory.ts";

const DEFAULT_MAX_CHARS = 20000;
const MAX_DESCRIPTION = 160;
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface Skill {
  name: string;
  description: string;
  path: string;
  source: "user" | "project";
  body: string;
  truncated: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface DiscoverSkillsOptions {
  cwd: string;
  globalDir: string;
  platform?: NodeJS.Platform;
  maxChars?: number;
}

function frontmatter(raw: string): { data: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: raw };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") data[match[1]!] = value;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

function firstLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
    return trimmed;
  }
  return undefined;
}

function parseSkill(
  file: string,
  source: Skill["source"],
  root: string,
  platform: NodeJS.Platform,
  maxChars: number,
): Skill | undefined {
  let raw: string;
  try {
    if (!statSync(file).isFile()) return undefined;
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const { data, body: rawBody } = frontmatter(raw);
  const name = (data["name"] ?? basename(file, ".md")).trim();
  if (!NAME_PATTERN.test(name)) return undefined;
  const described = (data["description"] ?? firstLine(rawBody) ?? "(no description)").replace(/\s+/g, " ").trim();
  const description = described.length > MAX_DESCRIPTION ? `${described.slice(0, MAX_DESCRIPTION - 3)}...` : described;
  const expanded = expandImports(rawBody, file, root, 0, platform).trim();
  const truncated = expanded.length > maxChars;
  return {
    name,
    description: description === "" ? "(no description)" : description,
    path: file,
    source,
    body: truncated ? `${expanded.slice(0, maxChars)}\n[skill truncated]` : expanded,
    truncated,
  };
}

function collect(directory: string, source: Skill["source"], options: Required<DiscoverSkillsOptions>): Skill[] {
  if (!existsSync(directory)) return [];
  const skills: Skill[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".md")).sort()) {
    const skill = parseSkill(join(directory, name), source, directory, options.platform, options.maxChars);
    if (skill !== undefined) skills.push(skill);
  }
  return skills;
}

export function discoverSkills(options: DiscoverSkillsOptions): Skill[] {
  const resolved: Required<DiscoverSkillsOptions> = {
    cwd: options.cwd,
    globalDir: options.globalDir,
    platform: options.platform ?? process.platform,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
  };
  const byName = new Map<string, Skill>();
  for (const skill of collect(resolved.globalDir, "user", resolved)) byName.set(skill.name, skill);
  for (const skill of collect(join(resolved.cwd, ".altiora", "skills"), "project", resolved)) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export function skillCatalog(skills: readonly Skill[]): SkillSummary[] {
  return skills.map((skill) => ({ name: skill.name, description: skill.description }));
}
