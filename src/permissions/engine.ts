import type { PermissionMode, PermissionRule } from "../config/schema.ts";
import { matchesResource, normalizeRules } from "./rules.ts";

export interface PermissionRequest {
  tool: string;
  resources: string[];
  readOnly: boolean;
}

export interface PermissionDecision {
  effect: "allow" | "ask" | "deny";
  reason: string;
  ruleId?: string;
}

export interface PermissionEngine {
  decide(request: PermissionRequest): PermissionDecision;
}

const PRIORITY: Record<PermissionDecision["effect"], number> = { allow: 0, ask: 1, deny: 2 };

export interface EngineOptions {
  mode: PermissionMode;
  rules: PermissionRule[];
  cwd: string;
  platform: NodeJS.Platform;
}

export function createPermissionEngine(options: EngineOptions): PermissionEngine {
  const rules = normalizeRules(options.rules);

  return {
    decide(request) {
      const matching = rules.filter(
        (rule) =>
          rule.tool === request.tool &&
          (rule.pattern === undefined ||
            request.resources.some((resource) =>
              matchesResource(rule.pattern!, resource, options.cwd, options.platform),
            )),
      );

      let effect: PermissionDecision["effect"];
      let reason: string;
      let ruleId: string | undefined;

      if (matching.length > 0) {
        const best = matching.reduce((current, candidate) =>
          PRIORITY[candidate.effect] >= PRIORITY[current.effect] ? candidate : current,
        );
        effect = best.effect;
        reason = `${best.effect} by rule ${best.tool}${best.pattern === undefined ? "" : `(${best.pattern})`}`;
        ruleId = best.id;
      } else if (request.readOnly) {
        effect = "allow";
        reason = "read-only tool";
      } else {
        effect = options.mode === "default" ? "ask" : "deny";
        reason = options.mode === "default" ? "no matching rule" : `${options.mode} mode`;
      }

      if (options.mode === "plan" && !request.readOnly) {
        return { effect: "deny", reason: "plan mode blocks writes" };
      }
      if (options.mode === "unattended" && effect === "ask") {
        return { effect: "deny", reason: `${reason}; unattended mode turns ask into deny` };
      }
      return ruleId === undefined ? { effect, reason } : { effect, reason, ruleId };
    },
  };
}
