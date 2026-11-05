import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { projectConfigFile, resolveAppPaths } from "../config/paths.ts";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
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
  sessions list|show    Inspect saved sessions
  config path|get|set   Inspect or change configuration
  init                  Write project config and AGENTS.md

Options:
  -h, --help            Show this help
  -v, --version         Print version

Status: M0 scaffold. Only --help, --version and 'config path' work.`;

function notImplemented(name: string): number {
  process.stderr.write(`${name} is not implemented yet (M0 scaffold)\n`);
  return EXIT_ERROR;
}

function configCommand(args: string[]): number {
  const [sub] = args;
  if (sub === undefined || sub === "path") {
    const paths = resolveAppPaths();
    process.stdout.write(`config   ${paths.configFile}\n`);
    process.stdout.write(`memory   ${paths.memoryFile}\n`);
    process.stdout.write(`sessions ${paths.sessionsDir}\n`);
    process.stdout.write(`project  ${projectConfigFile(process.cwd())}\n`);
    return EXIT_OK;
  }
  if (sub === "get" || sub === "set") {
    return notImplemented(`config ${sub}`);
  }
  process.stderr.write(`unknown config subcommand: ${sub}\n`);
  return EXIT_USAGE;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
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

  const [command] = positionals;
  if (values.help === true || command === undefined) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  switch (command) {
    case "run":
    case "init":
      return notImplemented(command);
    case "sessions":
      return notImplemented("sessions");
    case "config":
      return configCommand(positionals.slice(1));
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.stderr.write(`run '${BIN} --help' for usage\n`);
      return EXIT_USAGE;
  }
}

process.exitCode = main(process.argv.slice(2));
