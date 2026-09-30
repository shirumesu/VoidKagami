import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = process.platform === "win32" ? "win32/build.mjs" : `${process.platform}/build.sh`;
if (!["darwin", "linux", "win32"].includes(process.platform)) {
  throw new Error(`Unsupported native terminal platform: ${process.platform}`);
}
const result = spawnSync(process.platform === "win32" ? process.execPath : "bash", [
  fileURLToPath(new URL(script, import.meta.url)),
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
