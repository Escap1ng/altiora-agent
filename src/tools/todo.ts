import { HarnessError } from "../core/errors.ts";
import { asObject, requireString, type TodoItem, type ToolDefinition } from "./registry.ts";

interface TodoInput {
  todos: TodoItem[];
}

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export const todoTool: ToolDefinition<TodoInput> = {
  name: "todo_write",
  description: "Replace the task list for the current run.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete task list, in order.",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  parse(input) {
    const record = asObject(input);
    const raw = record["todos"];
    if (!Array.isArray(raw)) throw new HarnessError("todos must be an array", { code: "bad_request" });
    const todos = raw.map((item, index) => {
      const entry = asObject(item);
      const content = requireString(entry, "content");
      const status = requireString(entry, "status");
      if (!STATUSES.has(status)) {
        throw new HarnessError(`todos[${index}].status must be pending, in_progress or completed`, {
          code: "bad_request",
        });
      }
      return { content, status: status as TodoItem["status"] };
    });
    return { todos };
  },
  async execute(input, context) {
    context.todos = input.todos;
    if (input.todos.length === 0) {
      return { output: "(todo list cleared)", isError: false, truncated: false };
    }
    const marker = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
    const lines = input.todos.map((todo, index) => `${marker[todo.status]} ${index + 1}. ${todo.content}`);
    return { output: lines.join("\n"), isError: false, truncated: false };
  },
};
