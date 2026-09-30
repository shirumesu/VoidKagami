import { glob, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@voidkagami/agent";
import type { Tool } from "@voidkagami/ai";
import type { PermissionMode } from "@voidkagami/protocol";
import { Type, type Static, type TSchema } from "typebox";
import { parsePatch } from "./runtime/patch.ts";
import { assertWritable, sandboxOptions, type SandboxOptions } from "./runtime/sandbox.ts";
import { TaskManager } from "./runtime/tasks.ts";
export { TaskManager } from "./runtime/tasks.ts";
export type { SandboxOptions } from "./runtime/sandbox.ts";

export interface TodoItem { content: string; status: "pending" | "in_progress" | "completed"; }
export interface UserQuestion { question: string; options?: string[]; }
export interface DelegateInput { task: string; agent?: string; model?: string; tools?: string[]; worktree?: boolean; permissionMode?: PermissionMode; }
export interface ToolContext {
	cwd: string;
	sessionId: string;
	tasks: TaskManager;
	sandbox?: boolean | SandboxOptions;
	authorize(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
	beforeWrite(): Promise<void>;
	emit(type: string, payload: Record<string, unknown>): void | Promise<void>;
	askUser(questions: UserQuestion[], signal?: AbortSignal): Promise<unknown>;
	delegate(input: DelegateInput, signal?: AbortSignal): Promise<unknown>;
	setTodos?(items: TodoItem[]): void | Promise<void>;
	instructionsFor?(path: string): Promise<{ path: string; content: string }[]>;
}

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function decodeEntities(text: string): string {
	return text.replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi, (match, numeric: string | undefined, name: string | undefined) => {
		if (numeric) return String.fromCodePoint(numeric[0]?.toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number(numeric));
		return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[name ?? ""] ?? match;
	});
}

function htmlText(html: string): string {
	return decodeEntities(html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[\t ]+/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
}

async function writable(context: ToolContext, path: string): Promise<void> {
	let parent = path;
	while (true) {
		try { const canonical = await realpath(parent); assertWritable(resolve(canonical, path.slice(parent.length).replace(/^\//, "")), context.cwd, context.sandbox); return; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const next = dirname(parent); if (next === parent) throw error; parent = next; }
	}
}

async function instructions(context: ToolContext, path: string): Promise<string> {
	const documents = await context.instructionsFor?.(path) ?? [];
	return documents.length ? `${documents.map((document) => `Repository instructions (${document.path}):\n${document.content}`).join("\n\n")}\n\n` : "";
}

interface BuiltinDefinition<T extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: T;
	run(context: ToolContext, params: Static<T>, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

function define<T extends TSchema>(name: string, description: string, parameters: T, run: BuiltinDefinition<T>["run"]): BuiltinDefinition<T> {
	return { name, description, parameters, run };
}

const builtinDefinitions: BuiltinDefinition[] = [
		define("read", "Read a UTF-8 text file with numbered lines. Offset is 1-based; use view_image for images.", Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 3000 })) }), async (context, { path, offset = 1, limit = 300 }, signal) => {
			const resolved = resolve(context.cwd, path);
			const source = await readFile(resolved, { encoding: "utf8", signal });
			if (source.includes("\0")) throw new Error("This is a binary file. Use view_image for images or bash for a format-specific reader.");
			const lines = source.split("\n");
			const output = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}\t${line}`).join("\n");
			return textResult(await instructions(context, resolved) + output.slice(0, 64_000) + (offset - 1 + limit < lines.length ? `\n[${lines.length} total lines; continue at offset ${offset + limit}]` : ""), { path: resolved, totalLines: lines.length });
		}),
		define("write", "Write the complete UTF-8 contents of a file, creating parent directories when needed.", Type.Object({ path: Type.String(), content: Type.String() }), async (context, { path, content }, signal) => {
			const resolved = resolve(context.cwd, path);
			await writable(context, resolved);
			await context.beforeWrite();
			await mkdir(dirname(resolved), { recursive: true });
			await writeFile(resolved, content, { signal });
			return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${resolved}`, { path: resolved });
		}),
		define("edit", "Replace exact text in a UTF-8 file. old_text must match once unless replace_all is true. Preserve surrounding content.", Type.Object({ path: Type.String(), old_text: Type.String({ minLength: 1 }), new_text: Type.String(), replace_all: Type.Optional(Type.Boolean()) }), async (context, { path, old_text, new_text, replace_all = false }, signal) => {
			const resolved = resolve(context.cwd, path);
			await writable(context, resolved);
			const content = await readFile(resolved, { encoding: "utf8", signal });
			const occurrences = content.split(old_text).length - 1;
			if (!occurrences) throw new Error(`old_text was not found in ${path}`);
			if (occurrences > 1 && !replace_all) throw new Error(`old_text matches ${occurrences} times; include more context or use replace_all`);
			await context.beforeWrite();
			await writeFile(resolved, replace_all ? content.replaceAll(old_text, new_text) : content.replace(old_text, new_text), { signal });
			return textResult(`Updated ${resolved} (${replace_all ? occurrences : 1} replacement${replace_all && occurrences > 1 ? "s" : ""})`, { path: resolved });
		}),
		define("apply_patch", "Apply edits using *** Begin Patch, *** Add File: path (+lines), *** Update File: path (@@ hunks with space context, -old, +new), optional *** Move to: path, *** Delete File: path, *** End Patch. Paths resolve from the workspace.", Type.Object({ patch: Type.String() }), async (context, { patch }, signal) => {
			const changes = await parsePatch(patch, context.cwd, signal);
			for (const change of changes) { await writable(context, change.path); if (change.remove) await writable(context, change.remove); }
			await context.beforeWrite();
			for (const change of changes) {
				signal?.throwIfAborted();
				if (change.content !== undefined) { await mkdir(dirname(change.path), { recursive: true }); await writeFile(change.path, change.content, { signal }); }
				if (change.remove) await rm(change.remove);
			}
			return textResult(changes.map((change) => `${change.content === undefined ? "Deleted" : "Updated"} ${change.path}`).join("\n"), { paths: changes.map((change) => change.path) });
		}),
		define("bash", "Execute a shell command in the workspace. Use background for a long-running process, then task_read/task_list/task_stop to manage it. Foreground commands can be interrupted.", Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()), background: Type.Optional(Type.Boolean()), timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })) }), async (context, { command, cwd, background, timeout_ms }, signal) => {
			await context.beforeWrite();
			const task = await context.tasks.start({ sessionId: context.sessionId, command, cwd: cwd ? resolve(context.cwd, cwd) : context.cwd, background, timeoutMs: timeout_ms, signal, sandbox: { ...sandboxOptions(context.sandbox), workspace: context.cwd }, onOutput: (text) => { void context.emit("tool.progress", { tool: "bash", text }); } });
			if (!background) { signal?.throwIfAborted(); if (task.exitCode !== 0) throw new Error(`${task.output}\n[exit ${task.exitCode ?? "interrupted"}; task ${task.id}]`); }
			return textResult(background ? `Background task ${task.id} started (pid ${task.pid}).\n${task.output}` : `${task.output}\n[exit ${task.exitCode ?? "interrupted"}; task ${task.id}]`, task);
		}),
		define("task_list", "List this session's foreground and background shell tasks, including status and recent output.", Type.Object({}), async (context) => textResult(JSON.stringify(context.tasks.list(context.sessionId), null, 2))),
		define("task_read", "Read output from a session shell task. Offset counts characters in its full log.", Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128_000 })) }), async (context, { id, offset, limit }, signal) => {
			if (context.tasks.get(id).sessionId !== context.sessionId) throw new Error("Task belongs to another session");
			const result = await context.tasks.read(id, offset, limit, signal);
			return textResult(`${result.output}\n[${result.task.status}; next offset ${result.nextOffset}]`, result);
		}),
		define("task_stop", "Stop a shell task and its child processes.", Type.Object({ id: Type.String() }), async (context, { id }) => {
			if (context.tasks.get(id).sessionId !== context.sessionId) throw new Error("Task belongs to another session");
			context.tasks.stop(id); return textResult(`Stopping ${id}`);
		}),
		define("glob", "Find paths matching a glob in a directory. Excludes .git and node_modules. Examples: **/*.ts, src/**/*.md.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }), async (context, { pattern, path, limit = 500 }, signal) => {
			const results: string[] = [];
			const cwd = resolve(context.cwd, path ?? ".");
			for await (const file of glob(pattern, { cwd, exclude: ["**/.git/**", "**/node_modules/**"] })) { signal?.throwIfAborted(); results.push(file); if (results.length >= limit) break; }
			return textResult(await instructions(context, cwd) + (results.join("\n") || "No matches"), { cwd, count: results.length, limited: results.length === limit });
		}),
		define("grep", "Search text files using a JavaScript regular expression. Returns path:line:text matches; excludes .git and node_modules and skips binary files.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()), ignore_case: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }), async (context, { pattern, path, glob: filePattern = "**/*", ignore_case, limit = 100 }, signal) => {
			const target = resolve(context.cwd, path ?? ".");
			const targetStat = await stat(target);
			const expression = new RegExp(pattern, ignore_case ? "i" : "");
			const matches: string[] = [];
			const paths = targetStat.isFile() ? [target] : glob(filePattern, { cwd: target, exclude: ["**/.git/**", "**/node_modules/**"] });
			for await (const file of paths) {
				signal?.throwIfAborted();
				const absolute = targetStat.isFile() ? file : resolve(target, file);
				if (!(await stat(absolute)).isFile()) continue;
				const content = await readFile(absolute, { encoding: "utf8", signal });
				if (content.includes("\0")) continue;
				const lines = content.split("\n");
				for (let index = 0; index < lines.length; index++) { if (expression.test(lines[index]!)) matches.push(`${file}:${index + 1}:${lines[index]!.slice(0, 2000)}`); if (matches.length >= limit) break; }
				if (matches.length >= limit) break;
			}
			return textResult(await instructions(context, target) + (matches.join("\n") || "No matches"), { count: matches.length, limited: matches.length === limit });
		}),
		define("todo", "Replace the task plan with the current list and statuses. Keep task descriptions concrete.", Type.Object({ items: Type.Array(Type.Object({ content: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]) })) }), async (context, { items }) => {
			await context.setTodos?.(items);
			await context.emit("todo.updated", { items });
			return textResult(items.map((item) => `${item.status}: ${item.content}`).join("\n"), { items });
		}),
		define("ask_user", "Ask the user questions when a decision or missing information is needed. The tool waits for their response.", Type.Object({ questions: Type.Array(Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }), { minItems: 1, maxItems: 3 }) }), async (context, { questions }, signal) => {
			const answer = await context.askUser(questions, signal);
			return textResult(typeof answer === "string" ? answer : JSON.stringify(answer), { answer });
		}),
		define("web_fetch", "Fetch a web URL and extract readable text from HTML; returns plain text and JSON unchanged. Use explicit source URLs in your answer.", Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Integer({ minimum: 100, maximum: 100_000 })) }), async (context, { url, max_chars = 24_000 }, signal) => {
			const response = await fetch(url, { signal, headers: { "User-Agent": "VoidKagami/0.1", Accept: "text/html,text/plain,application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) throw new Error(`Unsupported content type ${contentType}; download with bash and use a format-specific reader`);
			const content = await response.text();
			const text = contentType.includes("html") ? htmlText(content) : content;
			return textResult(`Source: ${response.url}\n\n${text.slice(0, max_chars)}${text.length > max_chars ? "\n[Content truncated]" : ""}`, { url: response.url, contentType, totalChars: text.length });
		}),
		define("web_search", "Search the public web through DuckDuckGo and return source titles, URLs and snippets. Fetch selected URLs for full context.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), async (context, { query, limit = 5 }, signal) => {
			const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; VoidKagami/0.1)" } });
			if (!response.ok) throw new Error(`Search returned HTTP ${response.status}`);
			const html = await response.text();
			const matches = [...html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
			const snippets = [...html.matchAll(/<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
			const results = matches.slice(0, limit).map((match, index) => { const url = new URL(decodeEntities(match[1]!), "https://duckduckgo.com"); return { title: htmlText(match[2]!), url: url.searchParams.get("uddg") ?? url.href, snippet: htmlText(snippets[index]?.[1] ?? "") }; });
			if (!results.length && /anomaly|challenge|captcha/i.test(html)) throw new Error("Search provider requires browser verification. Try web_fetch with a known URL or an available MCP search tool.");
			return textResult(JSON.stringify(results, null, 2), { query, results });
		}),
		define("view_image", "Read a local PNG, JPEG, GIF or WebP image so it is visible to the model.", Type.Object({ path: Type.String() }), async (context, { path }, signal) => {
			const resolved = resolve(context.cwd, path);
			const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extname(path).toLowerCase()];
			if (!mimeType) throw new Error("Supported image formats: PNG, JPEG, GIF, WebP");
			return { content: [{ type: "image", mimeType, data: (await readFile(resolved, { signal })).toString("base64") }], details: { path: resolved } };
		}),
		define("subagent", "Delegate a bounded task to a child session and wait for its result. Optionally choose a named markdown agent, model (provider/id), restricted tool names, permission mode, or an isolated worktree. Permissions inherit from the parent unless explicitly specified.", Type.Object({ task: Type.String(), agent: Type.Optional(Type.String()), model: Type.Optional(Type.String()), tools: Type.Optional(Type.Array(Type.String())), worktree: Type.Optional(Type.Boolean()), permissionMode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("accept_edits"), Type.Literal("auto"), Type.Literal("plan")])) }), async (context, input, signal) => {
			const result = await context.delegate(input, signal);
			return textResult(typeof result === "string" ? result : JSON.stringify(result), { result });
		}),
];

export function listBuiltinToolDeclarations(): Tool[] {
	return builtinDefinitions.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function createBuiltinTools(context: ToolContext): AgentTool[] {
	return builtinDefinitions.map((definition) => ({
		name: definition.name,
		label: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		async execute(_id, args, signal) {
			signal?.throwIfAborted();
			await context.authorize(definition.name, args as Record<string, unknown>, signal);
			return definition.run(context, args, signal);
		},
	}));
}
