import type { PolicyRule, PolicyEffect } from "./types.js";

export type EvalContext = {
  toolName?: string;
  pluginId?: string;
  promptId?: string;
  modelId?: string;
  filePath?: string;
  userRole?: string;
  ip?: string;
};

export type EvalResult = {
  effect: PolicyEffect;
  matchedRule?: PolicyRule;
  reason?: string;
};

const MAX_GLOB_PATTERN_LENGTH = 100;

export class PolicyEnforcer {
  private policies: PolicyRule[] = [];
  private policyVersion = 0;

  updatePolicies(policies: PolicyRule[], version?: number): void {
    if (version != null && version <= this.policyVersion) return;
    this.policies = policies.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
    if (version != null) this.policyVersion = version;
  }

  get currentVersion(): number {
    return this.policyVersion;
  }

  evaluate(ctx: EvalContext): EvalResult {
    for (const rule of this.policies) {
      if (!this.matchesConditions(rule, ctx)) continue;
      if (this.matchesScope(rule, ctx)) {
        return { effect: rule.effect, matchedRule: rule, reason: `matched rule: ${rule.name}` };
      }
    }
    return { effect: "allow", reason: "no matching policy" };
  }

  private matchesConditions(rule: PolicyRule, ctx: EvalContext): boolean {
    const cond = rule.conditions;
    if (!cond) return true;
    if (cond.user_roles && cond.user_roles.length > 0) {
      if (!ctx.userRole || !cond.user_roles.includes(ctx.userRole)) return false;
    }
    if (cond.ip_ranges && cond.ip_ranges.length > 0) {
      if (!ctx.ip || !cond.ip_ranges.includes(ctx.ip)) return false;
    }
    return true;
  }

  private matchesScope(rule: PolicyRule, ctx: EvalContext): boolean {
    const target = rule.scope_target;
    switch (rule.scope_type) {
      case "tool":
        return ctx.toolName != null && this.globMatch(target, ctx.toolName);
      case "plugin":
        return ctx.pluginId != null && this.globMatch(target, ctx.pluginId);
      case "prompt":
        return ctx.promptId != null && this.globMatch(target, ctx.promptId);
      case "model":
        return ctx.modelId != null && this.globMatch(target, ctx.modelId);
      case "file_access":
        return ctx.filePath != null && this.globMatch(target, ctx.filePath);
      default:
        return false;
    }
  }

  private globMatch(pattern: string, value: string): boolean {
    if (pattern === "*") return true;
    if (pattern.length > MAX_GLOB_PATTERN_LENGTH) return false;
    if (!pattern.includes("*")) return pattern === value;

    const parts = pattern.split("*");
    let pos = 0;

    if (parts[0] && !value.startsWith(parts[0])) return false;
    pos = parts[0].length;

    for (let i = 1; i < parts.length - 1; i++) {
      if (!parts[i]) continue;
      const idx = value.indexOf(parts[i], pos);
      if (idx === -1) return false;
      pos = idx + parts[i].length;
    }

    const last = parts[parts.length - 1];
    if (last) {
      if (!value.endsWith(last)) return false;
      if (value.length - last.length < pos) return false;
    }
    return true;
  }
}
