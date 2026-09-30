import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SandboxOptions { enabled: boolean; network?: boolean; writableRoots?: string[]; workspace?: string; }

export function sandboxOptions(value: boolean | SandboxOptions | undefined): SandboxOptions {
	return typeof value === "boolean" ? { enabled: value } : value ?? { enabled: false };
}

export function assertWritable(path: string, cwd: string, options: boolean | SandboxOptions | undefined): void {
	const sandbox = sandboxOptions(options);
	if (!sandbox.enabled) return;
	const roots = [sandbox.workspace ?? cwd, tmpdir(), ...(sandbox.writableRoots ?? [])].map((root) => realpathSync(root));
	if (!roots.some((root) => { const rel = relative(resolve(root), resolve(path)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); })) {
		throw new Error(`Sandbox does not allow writing outside workspace: ${path}`);
	}
}

export function shellCommand(command: string, cwd: string, options: boolean | SandboxOptions | undefined): { command: string; args: string[] } {
	const sandbox = sandboxOptions(options);
	const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
	const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
	if (!sandbox.enabled) return { command: shell, args: shellArgs };
	const roots = [...new Set([sandbox.workspace ?? cwd, tmpdir(), ...(sandbox.writableRoots ?? [])].map((path) => realpathSync(path)))];
	if (process.platform === "darwin") {
		const profile = [`(version 1)`, `(allow default)`, `(deny file-write*)`, `(allow file-write* (literal "/dev/null") ${roots.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`, ...(sandbox.network ? [] : ["(deny network*)"])].join("\n");
		return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, shell, ...shellArgs] };
	}
	if (process.platform === "linux") {
		return { command: "bwrap", args: ["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...roots.flatMap((root) => ["--bind", root, root]), ...(sandbox.network ? [] : ["--unshare-net"]), "--chdir", cwd, "--", shell, ...shellArgs] };
	}
	throw new Error(`Sandbox is not supported on ${process.platform}`);
}
