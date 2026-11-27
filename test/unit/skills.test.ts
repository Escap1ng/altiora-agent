import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { buildRuntime } from "../../src/cli/runtime.ts";
import { buildSystemPrompt } from "../../src/core/context.ts";
import { discoverSkills, skillCatalog } from "../../src/skills/skills.ts";
import { skillTool } from "../../src/tools/skill.ts";

const cleanups: string[] = [];

after(() => {
  for (const directory of cleanups) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "altiora-skills-"));
  cleanups.push(directory);
  return directory;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function projectSkills(cwd: string): string {
  return join(cwd, ".altiora", "skills");
}

test("discovers frontmatter and fallback skills from user and project dirs", () => {
  const cwd = workspace();
  const globalDir = join(cwd, "cfg", "skills");
  write(join(globalDir, "review.md"), "---\nname: review\ndescription: Review a diff\n---\nReview steps.\n");
  write(join(globalDir, "notes.md"), "Free-form notes.\nMore detail.\n");
  write(join(projectSkills(cwd), "release.md"), "Prepare a release.\n");

  const skills = discoverSkills({ cwd, globalDir, platform: process.platform });
  assert.deepEqual(skills.map((skill) => skill.name), ["notes", "release", "review"]);
  const review = skills.find((skill) => skill.name === "review");
  assert.equal(review?.description, "Review a diff");
  assert.equal(review?.source, "user");
  assert.match(review?.body ?? "", /Review steps/);
  const notes = skills.find((skill) => skill.name === "notes");
  assert.equal(notes?.description, "Free-form notes.");
  const release = skills.find((skill) => skill.name === "release");
  assert.equal(release?.source, "project");
});

test("project skills override user skills with the same name", () => {
  const cwd = workspace();
  const globalDir = join(cwd, "cfg", "skills");
  write(join(globalDir, "same.md"), "user version\n");
  write(join(projectSkills(cwd), "same.md"), "project version\n");
  write(join(projectSkills(cwd), "same2.md"), "project only\n");

  const skills = discoverSkills({ cwd, globalDir, platform: process.platform });
  const same = skills.find((skill) => skill.name === "same");
  assert.equal(same?.source, "project");
  assert.match(same?.body ?? "", /project version/);
  assert.equal(skills.find((skill) => skill.name === "same2")?.source, "project");
});

test("invalid names are skipped and long bodies are capped", () => {
  const cwd = workspace();
  const globalDir = join(cwd, "cfg", "skills");
  write(join(globalDir, "bad name.md"), "ignored\n");
  write(join(globalDir, "long.md"), "x".repeat(100));

  const skills = discoverSkills({ cwd, globalDir, platform: process.platform, maxChars: 40 });
  assert.deepEqual(skills.map((skill) => skill.name), ["long"]);
  const long = skills[0];
  assert.equal(long?.truncated, true);
  assert.match(long?.body ?? "", /\[skill truncated\]/);
  assert.ok((long?.body.length ?? 0) < 100);
});

test("imports inside the skill directory expand and outside imports are rejected", () => {
  const cwd = workspace();
  const globalDir = join(cwd, "cfg", "skills");
  write(join(globalDir, "extra.md"), "extra content");
  write(join(globalDir, "main.md"), "@extra.md\n@missing.md\n@../outside.md\n");
  write(join(cwd, "cfg", "outside.md"), "outside content");

  const skills = discoverSkills({ cwd, globalDir, platform: process.platform });
  const main = skills.find((skill) => skill.name === "main");
  assert.match(main?.body ?? "", /extra content/);
  assert.match(main?.body ?? "", /\[missing import: missing\.md\]/);
  assert.match(main?.body ?? "", /\[skipped import outside the repository: \.\.\/outside\.md\]/);
});

test("the skill tool loads a body and reports unknown names", async () => {
  const cwd = workspace();
  const globalDir = join(cwd, "cfg", "skills");
  write(join(globalDir, "review.md"), "---\ndescription: Review a diff\n---\nStep one.\n");
  const skills = discoverSkills({ cwd, globalDir, platform: process.platform });
  const tool = skillTool(skills);

  const loaded = await tool.execute({ name: "review" }, {
    cwd,
    platform: process.platform,
    signal: new AbortController().signal,
    maxOutputChars: 1000,
    bash: { shell: "auto", timeoutMs: 1000 },
    todos: [],
  });
  assert.equal(loaded.isError, false);
  assert.match(loaded.output, /# skill review/);
  assert.match(loaded.output, /Step one/);

  const missing = await tool.execute({ name: "nope" }, {
    cwd,
    platform: process.platform,
    signal: new AbortController().signal,
    maxOutputChars: 1000,
    bash: { shell: "auto", timeoutMs: 1000 },
    todos: [],
  });
  assert.equal(missing.isError, true);
  assert.match(missing.output, /unknown skill: nope/);
});

test("the system prompt lists the skill catalog only when skills exist", () => {
  const base = { cwd: "/w", platform: process.platform, shell: "auto", memory: "" };
  const without = buildSystemPrompt(base);
  assert.equal(without.includes("# Skills"), false);

  const withSkills = buildSystemPrompt({
    ...base,
    skills: [{ name: "review", description: "Review a diff" }],
  });
  assert.match(withSkills, /# Skills/);
  assert.match(withSkills, /- review: Review a diff/);
});

test("buildRuntime registers the skill tool and injects the catalog", async () => {
  const cwd = workspace();
  const configDir = join(cwd, "cfg");
  const globalDir = join(configDir, "skills");
  write(join(globalDir, "review.md"), "---\ndescription: Review a diff\n---\nStep one.\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ALTIORA_CONFIG_DIR: configDir,
    ALTIORA_DATA_DIR: join(cwd, "data"),
    ALTIORA_API_KEY: "test-key",
  };

  const built = await buildRuntime(
    { cwd, env, stderr: { write: () => true } as unknown as NodeJS.WritableStream, version: "0.0.0" },
    { model: "m", "context-window": "128000" },
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.runtime.skills.map((skill) => skill.name), ["review"]);
  assert.deepEqual(skillCatalog(built.runtime.skills), [{ name: "review", description: "Review a diff" }]);
  assert.ok(built.runtime.registry.names().includes("skill"));
  assert.match(built.runtime.systemPrompt, /- review: Review a diff/);
});
