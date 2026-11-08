export interface SystemPromptOptions {
  cwd: string;
  platform: NodeJS.Platform;
  shell: string;
  memory: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const shell = options.platform === "win32" ? "PowerShell" : "sh";
  const parts = [
    "You are Altiora, a coding agent working inside a single workspace.",
    `Workspace: ${options.cwd}`,
    `Platform: ${options.platform}. Shell: ${shell}.`,
    "Use the provided tools to inspect and change files. Paths are relative to the workspace; reads and writes outside it are rejected.",
    "Prefer apply_patch for multi-file or multi-hunk edits; use edit for a single unique replacement.",
    "Keep changes scoped to the request, verify your work when a test command exists, and report what you changed.",
  ];
  if (options.shell !== "") parts.push(`Configured shell: ${options.shell}.`);
  if (options.memory.trim() !== "") {
    parts.push(`# Project instructions\n\n${options.memory.trim()}`);
  }
  return parts.join("\n\n");
}
