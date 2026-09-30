import { watch, type FSWatcher } from "node:fs";
import { glob, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool, AgentToolResult } from "@voidkagami/agent";
import type { HookConfig, McpServerConfig } from "@voidkagami/protocol";
import type { TSchema } from "typebox";
import { parse as parseYaml } from "yaml";
import { runProcess } from "./runtime/process.ts";
export type { HookConfig, McpServerConfig } from "@voidkagami/protocol";

export interface InstructionDocument { path: string; content: string; }
export interface MarkdownExtension {
	name: string;
	description: string;
	path: string;
	content: string;
	metadata: Record<string, unknown>;
}
export interface ExtensionCatalog {
	instructions: InstructionDocument[];
	skills: MarkdownExtension[];
	agents: MarkdownExtension[];
	commands: MarkdownExtension[];
}

function ancestors(path: string): string[] {
	const result = [resolve(path)];
	while (dirname(result.at(-1)!) !== result.at(-1)) result.push(dirname(result.at(-1)!));
	return result.reverse();
}

async function optionalRead(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function markdown(path: string, defaultName: string): Promise<MarkdownExtension> {
	const source = await readFile(path, "utf8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	const metadata = match ? (parseYaml(match[1]!) ?? {}) as Record<string, unknown> : {};
	const content = match ? source.slice(match[0].length) : source;
	const description = typeof metadata.description === "string" ? metadata.description.trim() : content.trim().split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
	return { name: typeof metadata.name === "string" ? metadata.name : defaultName, description, path, content, metadata };
}

export class ExtensionManager {
	readonly homeDir: string;
	readonly cwd: string;
	catalog: ExtensionCatalog = { instructions: [], skills: [], agents: [], commands: [] };
	private watchers: FSWatcher[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private reload: Promise<void> = Promise.resolve();
	private revision = 0;
	private loadedRevision = -1;
	private loading?: Promise<ExtensionCatalog>;

	constructor(homeDir: string, cwd: string) { this.homeDir = resolve(homeDir); this.cwd = resolve(cwd); }

	async instructionsFor(path = this.cwd): Promise<InstructionDocument[]> {
		let directory = resolve(this.cwd, path);
		try { if (!(await stat(directory)).isDirectory()) directory = dirname(directory); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; directory = dirname(directory); }
		const files = [...new Set([join(this.homeDir, "AGENTS.md"), ...ancestors(directory).map((parent) => join(parent, "AGENTS.md"))])];
		const documents = await Promise.all(files.map(async (file) => { const content = await optionalRead(file); return content === undefined ? undefined : { path: file, content }; }));
		return documents.filter((document): document is InstructionDocument => document !== undefined);
	}

	async load(force = false): Promise<ExtensionCatalog> {
		if (force) this.revision++;
		if (this.loadedRevision === this.revision) return this.catalog;
		if (this.loading) { await this.loading; return this.load(); }
		const revision = this.revision;
		this.loading = this.scan().then((catalog) => { this.catalog = catalog; this.loadedRevision = revision; return catalog; }).finally(() => { this.loading = undefined; });
		return this.loading;
	}

	private async scan(): Promise<ExtensionCatalog> {
		const roots = [this.homeDir, ...ancestors(this.cwd).flatMap((path) => [join(path, ".agents"), join(path, ".voidkagami")])];
		const loadKind = async (kind: "skills" | "agents" | "commands") => {
			const documents = new Map<string, MarkdownExtension>();
			for (const root of roots) {
				const base = join(root, kind);
				for await (const relative of glob(kind === "skills" ? "**/SKILL.md" : "**/*.md", { cwd: base })) {
					const path = join(base, relative);
					const defaultName = kind === "skills" ? basename(dirname(path)) : relative.slice(0, -extname(relative).length).replaceAll("/", ":");
					const document = await markdown(path, defaultName);
					documents.set(document.name, document);
				}
			}
			return [...documents.values()];
		};
		const [instructions, skills, agents, commands] = await Promise.all([this.instructionsFor(), loadKind("skills"), loadKind("agents"), loadKind("commands")]);
		return { instructions, skills, agents, commands };
	}

	async expandCommand(name: string, args = ""): Promise<string> {
		await this.load();
		const command = this.catalog.commands.find((item) => item.name === name.replace(/^\//, ""));
		if (!command) throw new Error(`Unknown command: ${name}`);
		const words = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
		return command.content.replace(/\$ARGUMENTS\b/g, args).replace(/\$(\d+)\b/g, (_match, index: string) => words[Number(index) - 1] ?? "");
	}

	watch(onChange?: (catalog: ExtensionCatalog) => void, onError?: (error: Error) => void): void {
		if (this.watchers.length) return;
		const changed = (_event: string, filename: string | Buffer | null) => {
			const path = filename?.toString() ?? "";
			if (path.split(/[\\/]/).some((segment) => segment === ".git" || segment === "node_modules")) return;
			if (path && !/(^|[\\/])AGENTS\.md$/.test(path) && !/(^|[\\/])(\.voidkagami[\\/]|\.agents[\\/])?(skills|agents|commands)([\\/]|$)/.test(path) && !/(^|[\\/])config\.json$/.test(path)) return;
			this.revision++;
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				this.reload = this.reload.then(async () => { const catalog = await this.load(); onChange?.(catalog); }).catch((error: Error) => { onError?.(error); });
			}, 100);
		};
		const roots = [this.homeDir, this.cwd, ...ancestors(this.cwd).filter((path) => path !== this.cwd).map((path) => join(path, "AGENTS.md"))];
		for (const root of new Set(roots)) {
			try { const watcher = watch(root, { recursive: !root.endsWith("AGENTS.md") }, changed); watcher.on("error", (error) => onError?.(error)); this.watchers.push(watcher); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}

	async runHooks(event: string, payload: Record<string, unknown>, hooks: HookConfig[], signal?: AbortSignal): Promise<Record<string, unknown>> {
		return runHooks(event, payload, hooks, this.cwd, signal);
	}

	close(): void { clearTimeout(this.timer); for (const watcher of this.watchers) watcher.close(); this.watchers = []; }
}

export async function runHooks(event: string, payload: Record<string, unknown>, hooks: HookConfig[], cwd: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
	let current = { ...payload };
	for (const hook of hooks.filter((hook) => hook.event === event)) {
		const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
		const args = process.platform === "win32" ? ["/d", "/s", "/c", hook.command] : ["-lc", hook.command];
		const result = await runProcess(shell, args, { cwd, input: JSON.stringify({ event, cwd, ...current }), signal, acceptedCodes: [0, 2] });
		if (result.code === 2) throw new Error(result.stderr.trim() || result.stdout.trim() || `Blocked by ${event} hook`);
		if (!result.stdout.trim()) continue;
		let response: Record<string, unknown>;
		try { response = JSON.parse(result.stdout) as Record<string, unknown>; }
		catch { current.additionalContext = [current.additionalContext, result.stdout.trim()].filter(Boolean).join("\n"); continue; }
		if (response.block === true || response.decision === "block") throw new Error(String(response.reason ?? `Blocked by ${event} hook`));
		current = { ...current, ...response };
	}
	return current;
}

interface McpConnection { config: string; client: Client; tools: McpTool[]; }
export interface McpToolContext {
	cwd?: string;
	authorize(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
	beforeWrite(): Promise<void>;
	emit?(type: string, payload: Record<string, unknown>): void | Promise<void>;
}

export class McpManager {
	private connections = new Map<string, McpConnection>();
	private context: McpToolContext;
	constructor(context: McpToolContext) { this.context = context; }
	setContext(context: McpToolContext): void { this.context = context; }

	async configure(servers: Record<string, McpServerConfig>): Promise<void> {
		for (const [name, connection] of this.connections) {
			if (JSON.stringify(servers[name]) !== connection.config) { this.connections.delete(name); await connection.client.close(); }
		}
		await Promise.all(Object.entries(servers).map(async ([name, config]) => {
			if (this.connections.has(name)) return;
			const client = new Client({ name: "voidkagami", version: "0.1.0" });
			const transport = config.url
				? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
				: config.command
					? new StdioClientTransport({ command: config.command, args: config.args, cwd: this.context.cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...config.env }, stderr: "pipe" })
					: undefined;
			if (!transport) throw new Error(`MCP server ${name} needs command or url`);
			try {
				await client.connect(transport);
				const connection: McpConnection = { config: JSON.stringify(config), client, tools: [] };
				const refresh = async () => {
					const tools: McpTool[] = [];
					let cursor: string | undefined;
					do { const page = await client.listTools({ cursor }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
					connection.tools = tools;
				};
				await refresh();
				client.setNotificationHandler(ToolListChangedNotificationSchema, refresh);
				client.onclose = () => { if (this.connections.get(name)?.client === client) this.connections.delete(name); };
				if (transport instanceof StdioClientTransport) transport.stderr?.on("data", (data: Buffer) => { void this.context.emit?.("mcp.log", { server: name, text: data.toString() }); });
				this.connections.set(name, connection);
			} catch (error) { await client.close(); throw error; }
		}));
	}

	tools(): AgentTool[] {
		return [...this.connections].flatMap(([server, connection]) => connection.tools.map((tool): AgentTool => ({
			name: `mcp__${server.replace(/[^\w-]/g, "_")}__${tool.name.replace(/[^\w-]/g, "_")}`,
			label: `${server}: ${tool.title ?? tool.name}`,
			description: tool.description ?? `Call ${tool.name} on MCP server ${server}`,
			parameters: tool.inputSchema as TSchema,
			execute: async (_id, args, signal) => {
				const name = `mcp__${server.replace(/[^\w-]/g, "_")}__${tool.name.replace(/[^\w-]/g, "_")}`;
				await this.context.authorize(name, args as Record<string, unknown>, signal);
				if (!tool.annotations?.readOnlyHint) await this.context.beforeWrite();
				const result = await connection.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { signal });
				const content: AgentToolResult<unknown>["content"] = [];
				for (const item of result.content as Record<string, unknown>[] ?? []) {
					if (item.type === "text") content.push({ type: "text", text: String(item.text) });
					else if (item.type === "image") content.push({ type: "image", data: String(item.data), mimeType: String(item.mimeType) });
					else content.push({ type: "text", text: JSON.stringify(item) });
				}
				if (result.isError) throw new Error(content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || `MCP ${name} failed`);
				if (!content.length) content.push({ type: "text", text: JSON.stringify(result.structuredContent ?? {}) });
				return { content, details: { server, tool: tool.name, structuredContent: result.structuredContent } };
			},
		})));
	}

	async close(): Promise<void> { await Promise.all([...this.connections.values()].map((connection) => connection.client.close())); this.connections.clear(); }
}
