import { HarnessError } from "../core/errors.ts";
import type { PatchHunk } from "./patch-parser.ts";

function patchError(message: string): HarnessError {
  return new HarnessError(`patch: ${message}`, { code: "bad_request" });
}

function matchesAt(lines: string[], oldLines: string[], at: number, tolerant: boolean): boolean {
  if (at + oldLines.length > lines.length) return false;
  for (let offset = 0; offset < oldLines.length; offset += 1) {
    const actual = lines[at + offset]!;
    const expected = oldLines[offset]!;
    if (tolerant) {
      if (actual.replace(/[ \t]+$/, "") !== expected.replace(/[ \t]+$/, "")) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function findMatches(lines: string[], oldLines: string[], start: number, tolerant: boolean): number[] {
  const matches: number[] = [];
  for (let at = start; at + oldLines.length <= lines.length; at += 1) {
    if (matchesAt(lines, oldLines, at, tolerant)) matches.push(at);
  }
  return matches;
}

function locate(lines: string[], oldLines: string[], start: number, path: string): number {
  const strict = findMatches(lines, oldLines, start, false);
  if (strict.length === 1) return strict[0]!;
  if (strict.length > 1) throw patchError(`hunk matches ${strict.length} locations in ${path}`);
  const tolerant = findMatches(lines, oldLines, start, true);
  if (tolerant.length === 1) return tolerant[0]!;
  if (tolerant.length > 1) throw patchError(`hunk matches ${tolerant.length} locations in ${path}`);
  throw patchError(`hunk does not match ${path}: no match for "${oldLines[0] ?? ""}"`);
}

export function applyHunks(original: string, path: string, hunks: PatchHunk[]): string {
  const crlf = original.includes("\r\n");
  const source = crlf ? original.replace(/\r\n/g, "\n") : original;
  let lines = source.split("\n");
  let searchStart = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);

    if (oldLines.length === 0) {
      const empty = lines.length === 1 && lines[0] === "";
      if (hunks.length === 1 && empty) {
        const added = hunk.lines.filter((line) => line.kind === "add").map((line) => line.text);
        lines = [...added, ""];
        continue;
      }
      throw patchError(`hunk for ${path} has no context to anchor`);
    }

    if (hunk.hint !== undefined) {
      const hintIndex = lines.findIndex((line, index) => index >= searchStart && line.includes(hunk.hint!));
      if (hintIndex !== -1) searchStart = hintIndex;
    }

    const at = locate(lines, oldLines, searchStart, path);
    const rebuilt: string[] = [];
    let oldOffset = 0;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        rebuilt.push(line.text);
      } else {
        if (line.kind === "context") rebuilt.push(lines[at + oldOffset]!);
        oldOffset += 1;
      }
    }
    lines.splice(at, oldLines.length, ...rebuilt);
    searchStart = at + rebuilt.length;
  }

  const joined = lines.join("\n");
  return crlf ? joined.replace(/\n/g, "\r\n") : joined;
}
