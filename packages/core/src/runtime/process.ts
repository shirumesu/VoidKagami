import { spawn } from "node:child_process";

export interface ProcessResult { stdout: string; stderr: string; code: number; }

export function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; acceptedCodes?: number[] } = {}): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
		child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
		child.once("error", reject);
		child.once("close", (code) => {
			const exitCode = code ?? 1;
			if (!(options.acceptedCodes ?? [0]).includes(exitCode)) reject(new Error(`${command} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`));
			else resolve({ stdout, stderr, code: exitCode });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input);
	});
}
