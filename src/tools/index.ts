export { bashTool } from "./bash.ts";
export { editTool } from "./edit.ts";
export { globTool } from "./glob.ts";
export { grepTool } from "./grep.ts";
export { lsTool } from "./ls.ts";
export { readTool } from "./read.ts";
export { todoTool } from "./todo.ts";
export { writeTool } from "./write.ts";

import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { todoTool } from "./todo.ts";
import { writeTool } from "./write.ts";
import type { ToolDefinition } from "./registry.ts";

export function defaultTools(): ToolDefinition[] {
  return [readTool, writeTool, editTool, bashTool, globTool, grepTool, lsTool, todoTool];
}
