import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chatCommand } from "./chat.ts";
import { configCommand } from "./config-command.ts";
import { initCommand } from "./init.ts";
import { runCommand } from "./run.ts";
import { sessionsCommand } from "./sessions.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 2;

interface PackageJson {
  name: string;
  version: string;
}

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageJson;

const BIN = "altiora";

const HELP = `Usage: ${BIN} <command> [options]

Commands:
  run <prompt>          Run a headless agent turn
  chat                  Start an interactive session
  sessions list|show    Inspect saved sessions
  config path|get|set   Inspect or change configuration
  init                  Write project config and AGENTS.md

Options:
  -h, --help            Show this help
  -v, --version         Print version`;

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version === true) {
    process.stdout.write(`${BIN} ${pkg.version}\n`);
    return EXIT_OK;
  }

  const commandIndex = argv.findIndex((arg) => !arg.startsWith("-"));
  const command = commandIndex === -1 ? undefined : argv[commandIndex];
  if (values.help === true || command === undefined) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }
  const rest = argv.slice(commandIndex + 1);

  switch (command) {
    case "run":
      return runCommand(rest, {
        cwd: process.cwd(),
        env: process.env,
        stdout: process.stdout,
        stderr: process.stderr,
        version: pkg.version,
      });
    case "chat":
      return chatCommand(rest, {
        cwd: process.cwd(),
        env: process.env,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        version: pkg.version,
      });
    case "init":
      return initCommand(rest, {
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      });
    case "sessions":
      return sessionsCommand(rest, {
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      });
    case "config":
      return configCommand(rest, {
        cwd: process.cwd(),
        env: process.env,
        stdout: process.stdout,
        stderr: process.stderr,
      });
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.stderr.write(`run '${BIN} --help' for usage\n`);
      return EXIT_USAGE;
  }
}

process.exitCode = await main(process.argv.slice(2));
