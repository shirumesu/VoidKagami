import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface FileChange { path: string; content?: string; remove?: string; }

export async function parsePatch(patch: string, cwd: string, signal?: AbortSignal): Promise<FileChange[]> {
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "*** Begin Patch") throw new Error("Patch must begin with *** Begin Patch");
	const changes: FileChange[] = [];
	let cursor = 1;
	while (cursor < lines.length && lines[cursor] !== "*** End Patch") {
		signal?.throwIfAborted();
		const header = lines[cursor++]!;
		if (header.startsWith("*** Add File: ")) {
			const path = resolve(cwd, header.slice(14));
			const added: string[] = [];
			while (cursor < lines.length && !lines[cursor]!.startsWith("*** ")) {
				const line = lines[cursor++]!;
				if (!line.startsWith("+")) throw new Error(`Added file lines must start with +: ${path}`);
				added.push(line.slice(1));
			}
			changes.push({ path, content: `${added.join("\n")}\n` });
		} else if (header.startsWith("*** Delete File: ")) {
			const path = resolve(cwd, header.slice(17));
			await readFile(path, { signal });
			changes.push({ path, remove: path });
		} else if (header.startsWith("*** Update File: ")) {
			const path = resolve(cwd, header.slice(17));
			let destination = path;
			if (lines[cursor]?.startsWith("*** Move to: ")) destination = resolve(cwd, lines[cursor++]!.slice(13));
			const original = await readFile(path, { encoding: "utf8", signal });
			const trailingNewline = original.endsWith("\n");
			const source = original.replace(/\r\n/g, "\n").split("\n");
			if (trailingNewline) source.pop();
			let searchStart = 0;
			let sawHunk = false;
			while (cursor < lines.length && !lines[cursor]!.startsWith("*** ")) {
				const hunkHeader = lines[cursor++]!;
				if (!hunkHeader.startsWith("@@")) throw new Error(`Expected @@ hunk in ${path}`);
				sawHunk = true;
				const anchor = hunkHeader.slice(2).trim();
				if (anchor) {
					const position = source.findIndex((line, index) => index >= searchStart && line === anchor);
					if (position < 0) throw new Error(`Patch anchor not found in ${path}: ${anchor}`);
					searchStart = position + 1;
				}
				const oldLines: string[] = [];
				const newLines: string[] = [];
				while (cursor < lines.length && !lines[cursor]!.startsWith("@@") && !lines[cursor]!.startsWith("*** ")) {
					const line = lines[cursor++]!;
					if (line.startsWith(" ")) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
					else if (line.startsWith("-")) oldLines.push(line.slice(1));
					else if (line.startsWith("+")) newLines.push(line.slice(1));
					else if (line === "") { oldLines.push(""); newLines.push(""); }
					else throw new Error(`Invalid patch line in ${path}: ${line}`);
				}
				const atEnd = lines[cursor] === "*** End of File";
				if (atEnd) cursor++;
				let match = -1;
				for (let index = searchStart; index <= source.length - oldLines.length; index++) {
					if (atEnd && index + oldLines.length !== source.length) continue;
					if (oldLines.every((line, offset) => source[index + offset] === line)) { match = index; break; }
				}
				if (match < 0) throw new Error(`Patch context not found in ${path}:\n${oldLines.join("\n")}`);
				source.splice(match, oldLines.length, ...newLines);
				searchStart = match + newLines.length;
			}
			if (!sawHunk) throw new Error(`No changes in update for ${path}`);
			changes.push({ path: destination, content: source.join("\n") + (trailingNewline ? "\n" : ""), ...(destination === path ? {} : { remove: path }) });
		} else throw new Error(`Unknown patch header: ${header}`);
	}
	if (lines[cursor] !== "*** End Patch") throw new Error("Patch must end with *** End Patch");
	return changes;
}
