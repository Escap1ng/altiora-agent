import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectConfigFile } from "../config/paths.ts";

export interface InitIo {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const CONFIG_TEMPLATE = {
  model: "",
  permissions: {
    mode: "default",
  },
};

const AGENTS_TEMPLATE = `# AGENTS.md

Project instructions for Altiora.

- Describe how to build and test this project.
- List conventions the agent should follow.
`;

export function initCommand(argv: string[], io: InitIo): number {
  const force = argv.includes("--force");
  const configPath = projectConfigFile(io.cwd);
  const agentsPath = join(io.cwd, "AGENTS.md");
  const written: string[] = [];

  try {
    mkdirSync(join(io.cwd, ".altiora"), { recursive: true });
    if (force || !existsSync(configPath)) {
      writeFileSync(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, "utf8");
      written.push(configPath);
    }
    if (force || !existsSync(agentsPath)) {
      writeFileSync(agentsPath, AGENTS_TEMPLATE, "utf8");
      written.push(agentsPath);
    }
  } catch (error) {
    io.stderr.write(`cannot initialize project: ${(error as Error).message}\n`);
    return 1;
  }

  if (written.length === 0) {
    io.stdout.write("nothing to write; pass --force to overwrite\n");
    return 0;
  }
  for (const path of written) io.stdout.write(`wrote ${path}\n`);
  return 0;
}
