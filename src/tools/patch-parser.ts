import { HarnessError } from "../core/errors.ts";

export type PatchLineKind = "context" | "remove" | "add";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchHunk {
  hint: string | undefined;
  lines: PatchLine[];
}

export type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "update"; path: string; moveTo: string | undefined; hunks: PatchHunk[] }
  | { kind: "delete"; path: string };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD_FILE = /^\*\*\* Add File:\s*(.*)$/;
const UPDATE_FILE = /^\*\*\* Update File:\s*(.*)$/;
const DELETE_FILE = /^\*\*\* Delete File:\s*(.*)$/;
const MOVE_TO = /^\*\*\* Move to:\s*(.*)$/;

function patchError(message: string): HarnessError {
  return new HarnessError(`patch: ${message}`, { code: "bad_request" });
}

function isDirective(line: string): boolean {
  return line.startsWith("*** ");
}

function skipBlank(lines: string[], index: number): number {
  let next = index;
  while (next < lines.length && lines[next]!.trim() === "") next += 1;
  return next;
}

function nextNonBlank(lines: string[], from: number): string | undefined {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() !== "") return line;
  }
  return undefined;
}

function endsBody(line: string | undefined, allowMove: boolean): boolean {
  if (line === undefined) return true;
  return isDirective(line) && !(allowMove && MOVE_TO.test(line));
}

function bodyEnds(lines: string[], index: number, allowMove: boolean): boolean {
  const line = lines[index];
  if (line === undefined) return true;
  if (line.trim() !== "") return endsBody(line, allowMove);
  const next = nextNonBlank(lines, index + 1);
  return next === undefined || endsBody(next, allowMove);
}

function requirePath(match: RegExpExecArray | null, directive: string): string {
  const path = match?.[1]?.trim();
  if (path === undefined || path === "") {
    throw patchError(`missing path after ${directive}`);
  }
  return path;
}

function parseAdd(lines: string[], index: number, header: string): { op: PatchOp; next: number } {
  const path = requirePath(ADD_FILE.exec(header), "*** Add File:");
  const body: string[] = [];
  let cursor = index + 1;
  while (!bodyEnds(lines, cursor, false)) {
    const line = lines[cursor]!;
    if (line.trim() === "") {
      body.push("");
    } else if (line.startsWith("+")) {
      body.push(line.slice(1));
    } else {
      throw patchError(`add file ${path}: lines must start with +, got "${line}"`);
    }
    cursor += 1;
  }
  return { op: { kind: "add", path, lines: body }, next: cursor };
}

function parseUpdate(lines: string[], index: number, header: string): { op: PatchOp; next: number } {
  const path = requirePath(UPDATE_FILE.exec(header), "*** Update File:");
  let moveTo: string | undefined;
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  let cursor = index + 1;

  const ensureHunk = (): PatchHunk => {
    if (current === undefined) {
      current = { hint: undefined, lines: [] };
      hunks.push(current);
    }
    return current;
  };

  while (!bodyEnds(lines, cursor, true)) {
    const line = lines[cursor]!;
    if (line.trim() === "" && hunks.length === 0 && current === undefined) {
      cursor += 1;
      continue;
    }
    const move = MOVE_TO.exec(line);
    if (move !== null) {
      if (hunks.length > 0 || current !== undefined) {
        throw patchError(`move to must precede hunks in ${path}`);
      }
      if (moveTo !== undefined) throw patchError(`duplicate move for ${path}`);
      moveTo = requirePath(move, "*** Move to:");
      cursor += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      const hint = line.slice(2).trim();
      current = { hint: hint === "" ? undefined : hint, lines: [] };
      hunks.push(current);
      cursor += 1;
      continue;
    }
    if (line.trim() === "") {
      ensureHunk().lines.push({ kind: "context", text: "" });
      cursor += 1;
      continue;
    }
    const prefix = line[0];
    if (prefix === " ") {
      ensureHunk().lines.push({ kind: "context", text: line.slice(1) });
    } else if (prefix === "-") {
      ensureHunk().lines.push({ kind: "remove", text: line.slice(1) });
    } else if (prefix === "+") {
      ensureHunk().lines.push({ kind: "add", text: line.slice(1) });
    } else {
      throw patchError(`update file ${path}: unsupported line "${line}"`);
    }
    cursor += 1;
  }

  for (const hunk of hunks) {
    if (hunk.lines.length === 0) throw patchError(`update file ${path}: empty hunk`);
  }
  if (hunks.length === 0 && moveTo === undefined) {
    throw patchError(`update file ${path} has no hunks`);
  }
  return { op: { kind: "update", path, moveTo, hunks }, next: cursor };
}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.split(/\r?\n/);
  let index = skipBlank(lines, 0);
  if (lines[index] !== BEGIN) {
    throw patchError(`expected "${BEGIN}", got "${lines[index] ?? ""}"`);
  }
  index += 1;

  const ops: PatchOp[] = [];
  for (;;) {
    index = skipBlank(lines, index);
    const line = lines[index];
    if (line === undefined) throw patchError(`missing "${END}"`);
    if (line === END) {
      index += 1;
      break;
    }
    if (ADD_FILE.test(line)) {
      const parsed = parseAdd(lines, index, line);
      ops.push(parsed.op);
      index = parsed.next;
      continue;
    }
    if (UPDATE_FILE.test(line)) {
      const parsed = parseUpdate(lines, index, line);
      ops.push(parsed.op);
      index = parsed.next;
      continue;
    }
    if (DELETE_FILE.test(line)) {
      ops.push({ kind: "delete", path: requirePath(DELETE_FILE.exec(line), "*** Delete File:") });
      index += 1;
      continue;
    }
    throw patchError(`unexpected line "${line}"`);
  }

  index = skipBlank(lines, index);
  if (index < lines.length) {
    throw patchError(`unexpected content after "${END}": "${lines[index]!}"`);
  }
  if (ops.length === 0) throw patchError("patch contains no operations");
  return ops;
}
