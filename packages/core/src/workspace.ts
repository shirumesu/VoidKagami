import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { runProcess } from "./runtime/process.ts";

export interface WorkspaceSnapshot { id: string; cwd: string; createdAt: string; }
export interface WorktreeInfo { path: string; branch: string; }

export class WorkspaceManager {
	readonly dataDir: string;
	private text: (english: string, chinese: string) => string;
	private queues = new Map<string, Promise<unknown>>();
	constructor(dataDir: string, text: (english: string, chinese: string) => string = (english) => english) { this.dataDir = dataDir; this.text = text; }

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

	async branchDiff(cwd: string, requestedBase?: string): Promise<{ diff: string; currentBranch: string; baseBranch: string }> {
		const repository = (await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
		const branch = await runProcess("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repository, acceptedCodes: [0, 1] });
		const currentBranch = branch.stdout.trim() || (await runProcess("git", ["rev-parse", "--short", "HEAD"], { cwd: repository })).stdout.trim();
		let baseBranch = requestedBase;
		if (!baseBranch) {
			const upstream = await runProcess("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: repository, acceptedCodes: [0, 128] });
			const remoteHead = upstream.code === 0 ? undefined : await runProcess("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repository, acceptedCodes: [0, 1, 128] });
			const refs = (await runProcess("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: repository })).stdout.trim().split("\n");
			baseBranch = upstream.stdout.trim() || remoteHead?.stdout.trim()
				|| ["origin/main", "origin/master", "main", "master"].find((ref) => refs.includes(ref)) || currentBranch;
		}
		const verified = await runProcess("git", ["rev-parse", "--verify", "--end-of-options", `${baseBranch}^{commit}`], { cwd: repository, acceptedCodes: [0, 128] });
		if (verified.code !== 0) throw new Error(this.text(`Cannot review changes against ${baseBranch}: the Git reference does not exist`, `无法与 ${baseBranch} 比较：Git 引用不存在`));
		const mergeBase = await runProcess("git", ["merge-base", verified.stdout.trim(), "HEAD"], { cwd: repository, acceptedCodes: [0, 1, 128] });
		if (mergeBase.code !== 0) throw new Error(this.text(`Cannot review changes against ${baseBranch}: the branches have no common commit`, `无法与 ${baseBranch} 比较：两个分支没有共同提交`));
		const tracked = await runProcess("git", ["diff", "--no-ext-diff", "--no-color", mergeBase.stdout.trim(), "--"], { cwd: repository });
		const untracked = await runProcess("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repository });
		const diffs = [tracked.stdout];
		for (const path of untracked.stdout.split("\0").filter(Boolean)) {
			const result = await runProcess("git", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", process.platform === "win32" ? "NUL" : "/dev/null", path], { cwd: repository, acceptedCodes: [0, 1] });
			diffs.push(result.stdout);
		}
		return { diff: diffs.filter(Boolean).join("\n"), currentBranch, baseBranch };
	}

	async createWorktree(cwd: string, options: { name: string; ref?: string }): Promise<WorktreeInfo> {
		const repository = (await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
		const name = options.name.replace(/[^a-zA-Z0-9._-]/g, "-");
		if (!name) throw new Error(this.text("A worktree name is required", "请填写工作树名称"));
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
