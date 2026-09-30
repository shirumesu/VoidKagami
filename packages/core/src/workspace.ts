import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { runProcess } from "./runtime/process.ts";

export interface WorkspaceSnapshot { id: string; cwd: string; createdAt: string; }
export interface WorktreeInfo { path: string; branch: string; }

export class WorkspaceManager {
	readonly dataDir: string;
	private queues = new Map<string, Promise<unknown>>();
	constructor(dataDir: string) { this.dataDir = dataDir; }

	private async repository(cwd: string): Promise<{ cwd: string; gitDir: string }> {
		const workspace = await realpath(cwd);
		const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
		const gitDir = join(this.dataDir, "snapshots", hash);
		await mkdir(gitDir, { recursive: true });
		await runProcess("git", ["init", "--bare", "--quiet", gitDir]);
		await writeFile(join(gitDir, "info", "exclude"), ".git\nnode_modules/\n.voidkagami/\n");
		return { cwd: workspace, gitDir };
	}

	private async git(cwd: string, gitDir: string, args: string[], input?: string): Promise<string> {
		const result = await runProcess("git", ["--git-dir", gitDir, "--work-tree", cwd, ...args], {
			cwd, input,
			env: { ...process.env, GIT_AUTHOR_NAME: "VoidKagami", GIT_AUTHOR_EMAIL: "snapshot@voidkagami.local", GIT_COMMITTER_NAME: "VoidKagami", GIT_COMMITTER_EMAIL: "snapshot@voidkagami.local" },
		});
		return result.stdout.trim();
	}

	private async serialized<T>(cwd: string, action: () => Promise<T>): Promise<T> {
		const key = await realpath(cwd);
		const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
		this.queues.set(key, next);
		try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
	}

	async snapshot(cwd: string): Promise<WorkspaceSnapshot> {
		return this.serialized(cwd, async () => {
			const repo = await this.repository(cwd);
			await this.git(repo.cwd, repo.gitDir, ["add", "--all", "--", "."]);
			const tree = await this.git(repo.cwd, repo.gitDir, ["write-tree"]);
			const createdAt = new Date().toISOString();
			const id = await this.git(repo.cwd, repo.gitDir, ["commit-tree", tree], `Workspace snapshot ${createdAt}\n`);
			await this.git(repo.cwd, repo.gitDir, ["update-ref", `refs/snapshots/${id}`, id]);
			return { id, cwd: repo.cwd, createdAt };
		});
	}

	async restore(cwd: string, snapshotId: string): Promise<void> {
		await this.serialized(cwd, async () => {
			const repo = await this.repository(cwd);
			const id = await this.git(repo.cwd, repo.gitDir, ["rev-parse", "--verify", `${snapshotId}^{commit}`]);
			await this.git(repo.cwd, repo.gitDir, ["add", "--all", "--", "."]);
			await this.git(repo.cwd, repo.gitDir, ["reset", "--hard", id]);
		});
	}

	async restoreInto(sourceCwd: string, targetCwd: string, snapshotId: string): Promise<void> {
		if (await realpath(sourceCwd) === await realpath(targetCwd)) return this.restore(sourceCwd, snapshotId);
		await this.serialized(targetCwd, async () => {
			const source = await this.repository(sourceCwd);
			const target = await this.repository(targetCwd);
			const id = await this.git(source.cwd, source.gitDir, ["rev-parse", "--verify", `${snapshotId}^{commit}`]);
			await this.git(target.cwd, target.gitDir, ["fetch", "--quiet", "--no-tags", source.gitDir, id]);
			await this.git(target.cwd, target.gitDir, ["update-ref", `refs/snapshots/${id}`, id]);
			await this.git(target.cwd, target.gitDir, ["add", "--all", "--", "."]);
			await this.git(target.cwd, target.gitDir, ["reset", "--hard", id]);
		});
	}

	async copySnapshot(sourceCwd: string, targetCwd: string, snapshotId: string): Promise<void> {
		await this.restoreInto(sourceCwd, targetCwd, snapshotId);
	}

	async diff(cwd: string, snapshotId: string, targetId?: string): Promise<string> {
		return this.serialized(cwd, async () => {
			const repo = await this.repository(cwd);
			if (!targetId) await this.git(repo.cwd, repo.gitDir, ["add", "--all", "--", "."]);
			return this.git(repo.cwd, repo.gitDir, ["diff", "--no-ext-diff", "--no-color", ...(targetId ? [snapshotId, targetId] : ["--cached", snapshotId]), "--"]);
		});
	}

	async createWorktree(cwd: string, options: { name: string; ref?: string }): Promise<WorktreeInfo> {
		const repository = (await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
		const name = options.name.replace(/[^a-zA-Z0-9._-]/g, "-");
		if (!name) throw new Error("A worktree name is required");
		const path = resolve(this.dataDir, "worktrees", `${basename(repository)}-${name}`);
		const branch = `voidkagami/${name}`;
		await mkdir(join(this.dataDir, "worktrees"), { recursive: true });
		await runProcess("git", ["worktree", "add", "-b", branch, path, options.ref ?? "HEAD"], { cwd: repository });
		return { path, branch };
	}

	async listWorktrees(cwd: string): Promise<{ path: string; branch?: string; head?: string }[]> {
		const output = (await runProcess("git", ["worktree", "list", "--porcelain"], { cwd })).stdout;
		return output.trim().split("\n\n").filter(Boolean).map((entry) => {
			const fields = Object.fromEntries(entry.split("\n").map((line) => { const i = line.indexOf(" "); return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)]; }));
			return { path: fields.worktree!, branch: fields.branch?.replace(/^refs\/heads\//, ""), head: fields.HEAD };
		});
	}

	async removeWorktree(cwd: string, path: string): Promise<void> {
		await runProcess("git", ["worktree", "remove", path], { cwd });
	}
}
