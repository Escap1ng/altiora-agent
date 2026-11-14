import { readFileSync } from "node:fs";
import { sessionDirFor } from "../config/paths.ts";
import { deriveMessages } from "../session/derive.ts";
import { parseRecords } from "../session/records.ts";
import { listSessions, resolveSessionPath } from "../session/store.ts";

export interface SessionsIo {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function sessionsCommand(argv: string[], io: SessionsIo): number {
  const sub = argv[0];
  const directory = sessionDirFor(io.cwd);

  if (sub === undefined || sub === "list") {
    const sessions = listSessions(directory);
    if (argv.includes("--json")) {
      io.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      return 0;
    }
    if (sessions.length === 0) {
      io.stdout.write(`(no sessions in ${directory})\n`);
      return 0;
    }
    for (const session of sessions) {
      const updated = new Date(session.updatedAt).toISOString();
      io.stdout.write(
        `${session.id}  ${updated}  ${session.model || "-"}  ${session.title || "(untitled)"}  ${session.records} records\n`,
      );
    }
    return 0;
  }

  if (sub === "show") {
    const id = argv[1];
    if (id === undefined) {
      io.stderr.write("usage: altiora sessions show <id>\n");
      return 2;
    }
    let raw: string;
    try {
      raw = readFileSync(resolveSessionPath(directory, id), "utf8");
    } catch (error) {
      io.stderr.write(`cannot read session ${id}: ${(error as Error).message}\n`);
      return 1;
    }
    const records = parseRecords(raw);
    if (argv.includes("--json")) {
      io.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
      return 0;
    }
    const { messages } = deriveMessages(records);
    for (const message of messages) {
      if (message.role === "assistant") {
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : `[tool ${part.name}]`))
          .join("\n");
        io.stdout.write(`assistant: ${text}\n`);
      } else if (message.role === "tool") {
        io.stdout.write(`tool(${message.toolCallId})${message.isError ? " error" : ""}: ${message.output}\n`);
      } else {
        io.stdout.write(`${message.role}: ${message.content}\n`);
      }
    }
    return 0;
  }

  io.stderr.write(`unknown sessions subcommand: ${sub}\n`);
  return 2;
}
