import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskInfo } from "@voidkagami/protocol";
import { shellCommand, type SandboxOptions } from "./sandbox.ts";

interface RunningTask { info: TaskInfo; child?: ChildProcess; done: Promise<TaskInfo>; }

export class TaskManager {
	private tasks = new Map<string, RunningTask>();
	readonly directory?: string;
	constructor(dataDir?: string) {
		if (!dataDir) return;
		this.directory = join(dataDir, "tasks");
		mkdirSync(this.directory, { recursive: true });
		for (const name of readdirSync(this.directory).filter((name) => name.endsWith(".json"))) {
			const info = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as TaskInfo;
			if (info.status === "running") { info.status = "failed"; info.exitCode = null; info.output += "\nTask interrupted when the service stopped."; this.persist(info); }
			this.tasks.set(info.id, { info, done: Promise.resolve(info) });
		}
	}

	private persist(info: TaskInfo): void {
		if (this.directory) writeFileSync(join(this.directory, `${info.id}.json`), JSON.stringify(info), { mode: 0o600 });
	}

	async start(options: { sessionId: string; command: string; cwd: string; background?: boolean; timeoutMs?: number; signal?: AbortSignal; sandbox?: boolean | SandboxOptions; onOutput?: (text: string) => void }): Promise<TaskInfo> {
		options.signal?.throwIfAborted();
		const id = randomUUID();
		const info: TaskInfo = { id, sessionId: options.sessionId, command: options.command, status: "running", output: "" };
		const invocation = shellCommand(options.command, options.cwd, options.sandbox);
		const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		info.pid = child.pid;
		const log = this.directory ? createWriteStream(join(this.directory, `${id}.log`), { mode: 0o600 }) : undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let resolveDone!: (task: TaskInfo) => void;
		const done = new Promise<TaskInfo>((resolve) => { resolveDone = resolve; });
		const task: RunningTask = { info, child, done };
		this.tasks.set(id, task);
		this.persist(info);
		const append = (text: string) => {
			info.output = (info.output + text).slice(-128_000);
			log?.write(text);
			options.onOutput?.(text);
		};
		const abort = () => this.stop(id);
		const finish = (exitCode: number | null) => {
			if (info.status !== "running") return;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			info.exitCode = exitCode;
			info.status = exitCode === 0 ? "completed" : "failed";
			delete task.child;
			this.persist(info);
			if (log) log.end(() => resolveDone({ ...info }));
			else resolveDone({ ...info });
		};
		child.stdout!.setEncoding("utf8").on("data", append);
		child.stderr!.setEncoding("utf8").on("data", append);
		child.once("error", (error) => { append(`${error.message}\n`); finish(null); });
		child.once("close", finish);
		log?.on("error", (error) => { info.output += `\nTask log: ${error.message}`; });
		if (options.timeoutMs) timeout = setTimeout(() => { append(`\nCommand timed out after ${options.timeoutMs} ms.\n`); this.stop(id); }, options.timeoutMs);
		if (!options.background) options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted && !options.background) abort();
		if (options.background) return { ...info };
		return done;
	}

	list(sessionId?: string): TaskInfo[] { return [...this.tasks.values()].filter(({ info }) => !sessionId || info.sessionId === sessionId).map(({ info }) => ({ ...info })); }

	get(id: string): TaskInfo {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown background task: ${id}`);
		return { ...task.info };
	}

	async read(id: string, offset = 0, limit = 32_000, signal?: AbortSignal): Promise<{ task: TaskInfo; output: string; nextOffset: number }> {
		const task = this.get(id);
		const output = this.directory ? await readFile(join(this.directory, `${id}.log`), { encoding: "utf8", signal }) : task.output;
		return { task, output: output.slice(offset, offset + limit), nextOffset: Math.min(offset + limit, output.length) };
	}

	stop(id: string): void {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown background task: ${id}`);
		if (!task.child?.pid) return;
		const child = task.child;
		const signal = (value: NodeJS.Signals) => {
			try { if (process.platform === "win32") child.kill(value); else process.kill(-child.pid!, value); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		};
		signal("SIGTERM");
		const timer = setTimeout(() => { if (task.child) signal("SIGKILL"); }, 1_500);
		timer.unref();
	}

	async close(): Promise<void> {
		for (const task of this.tasks.values()) if (task.child) this.stop(task.info.id);
		await Promise.all([...this.tasks.values()].map((task) => task.done));
	}
	async shutdown(): Promise<void> { await this.close(); }
}
