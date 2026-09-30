import type { PermissionMode, PermissionRule } from "@voidkagami/protocol";
export type { PermissionMode, PermissionRule } from "@voidkagami/protocol";
export type PermissionDecision = "allow" | "deny" | "ask";

const readTools = new Set(["read", "grep", "glob", "view_image", "web_fetch", "web_search", "task_list", "task_read", "ask_user", "todo"]);
const editTools = new Set(["write", "edit", "apply_patch"]);

export function matchesPattern(value: string, pattern: string): boolean {
	const expression = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*");
	return new RegExp(`^${expression}$`).test(value);
}

export function isReadOnlyTool(tool: string, _args: Record<string, unknown>): boolean {
	return readTools.has(tool);
}

export function evaluatePermission(mode: PermissionMode, rules: PermissionRule[], tool: string, args: Record<string, unknown>): PermissionDecision {
	const matching = rules.filter((rule) => matchesPattern(tool, rule.tool)
		&& (rule.pattern === undefined || matchesPattern(String(args.command ?? args.path ?? JSON.stringify(args)), rule.pattern))
		&& Object.entries(rule.arguments ?? {}).every(([key, pattern]) => matchesPattern(String(args[key] ?? ""), pattern)));
	if (matching.some((rule) => rule.action === "deny")) return "deny";
	if (mode === "plan" && (tool === "bash" || !isReadOnlyTool(tool, args))) return "deny";
	const explicit = matching.at(-1);
	if (explicit) return explicit.action;
	if (mode === "auto" || isReadOnlyTool(tool, args)) return "allow";
	if (mode === "accept_edits" && editTools.has(tool)) return "allow";
	return "ask";
}
