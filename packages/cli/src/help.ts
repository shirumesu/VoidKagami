import { renderWordmark } from "./brand.ts";
import { t } from "./i18n.ts";

export function helpText(isTTY: boolean, columns: number) {
  const banner = isTTY && columns >= 72 ? `${renderWordmark().join("\n")}\n` : "VoidKagami\n";
  return `${banner}${t(`Usage: voidkagami [chat] [prompt] [options]
       voidkagami run <prompt> [--json] [--mode auto]
       voidkagami attach <session-id>
       voidkagami abort <session-id>
       voidkagami sessions [search] [--json]
       voidkagami models [--json]
       voidkagami login [openai|provider] [--key-stdin]
       voidkagami logout <provider>
       voidkagami config [key [json-value]]
       voidkagami status | stop

Options:
  --cwd <path>          Project directory (default: current directory)
  --session <id>        Continue an existing session
  -c, --continue        Continue the latest session in this directory
  -r, --resume          Pick a saved session (or use --session <id>)
  -p, --print           Run a prompt without the interactive interface
  --model <provider/id> Model for a new session
  --mode <mode>         ask, accept_edits, auto, plan
  --worktree            Create an isolated Git worktree
  --branch <branch>     Git branch for the new worktree
  --image <path>        Attach an image (repeatable)
  --file <path>         Attach a file (repeatable)
  --json                Emit JSON; run streams JSONL events
  --help | --version

Interactive: /help for commands, Esc to stop, Shift+Enter for a new line.
/language switches English/Simplified Chinese; /clear is an alias for /new.
abort stops one session; stop shuts down the entire shared daemon.
Closing a client leaves running tasks in the shared daemon.`, `用法：voidkagami [chat] [提示词] [选项]
      voidkagami run <提示词> [--json] [--mode auto]
      voidkagami attach <会话 ID>
      voidkagami abort <会话 ID>
      voidkagami sessions [搜索词] [--json]
      voidkagami models [--json]
      voidkagami login [openai|服务商] [--key-stdin]
      voidkagami logout <服务商>
      voidkagami config [配置项 [JSON 值]]
      voidkagami status | stop

选项：
  --cwd <路径>         项目目录（默认当前目录）
  --session <id>       继续现有会话
  -c, --continue       继续此目录的最近会话
  -r, --resume         选择已保存的会话
  -p, --print          以非交互模式执行提示词
  --model <服务商/id>  新会话使用的模型
  --mode <模式>        ask、accept_edits、auto、plan
  --worktree           创建隔离的 Git 工作树
  --branch <分支>      新工作树的分支
  --image <路径>       添加图片（可重复）
  --file <路径>        添加文件（可重复）
  --json               输出 JSON；执行过程输出 JSONL 事件
  --help | --version

交互模式：/help 查看命令，Esc 停止，Shift+Enter 换行。
/language 切换简体中文或英文；/clear 是 /new 的别名。
abort 停止一个会话；stop 关闭共享 daemon。
关闭客户端后，后台任务继续执行。`)}`;
}
