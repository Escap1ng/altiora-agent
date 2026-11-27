import { asObject, requireString, type ToolDefinition } from "./registry.ts";
import type { Skill } from "../skills/skills.ts";

interface SkillInput {
  name: string;
}

export function skillTool(skills: readonly Skill[]): ToolDefinition<SkillInput> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    name: "skill",
    description: "Load a skill's instructions by name. The available skills are listed in the system prompt.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the catalog." },
      },
      required: ["name"],
    },
    parse(input) {
      return { name: requireString(asObject(input), "name") };
    },
    resources: () => [],
    async execute(input) {
      const skill = byName.get(input.name);
      if (skill === undefined) {
        return { output: `unknown skill: ${input.name}`, isError: true, truncated: false };
      }
      return {
        output: `# skill ${skill.name}\n\n${skill.body}`,
        isError: false,
        truncated: skill.truncated,
      };
    },
  };
}
