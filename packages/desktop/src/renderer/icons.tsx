import {
  AlarmClock, Archive, ArchiveRestore, ArrowDown, ArrowUp, Ban, BookOpen, Bot, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleAlert, CircleCheck, CircleDot, CircleQuestionMark, CircleStop, CircleX, Clock3, Copy, Ellipsis, ExternalLink, Eye,
  File, FileSearch, FileText, Folder, FolderOpen, FolderPlus, GitBranch, GitCompare, GitFork, Globe, Image, ImagePlus,
  Braces, Keyboard, KeyRound, ListChecks, ListTodo, LoaderCircle, MessageSquare, MessageSquarePlus, Palette, PanelLeft, PanelLeftOpen, PanelRight,
  Paperclip, Pin, PinOff, Plus, RotateCcw, Search, Send, Settings, SlidersHorizontal, Square, Terminal, Trash, Undo2, UserRound, X,
} from "lucide-react";

const icons = {
  folder: Folder, "folder-open": FolderOpen, "folder-plus": FolderPlus, archive: Archive, restore: ArchiveRestore,
  pin: Pin, unpin: PinOff, compose: MessageSquarePlus, settings: Settings, panel: PanelRight, "panel-left": PanelLeft,
  "panel-left-open": PanelLeftOpen, review: GitCompare, plus: Plus, chevron: ChevronRight, "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft, close: X, more: Ellipsis, search: Search, copy: Copy, fork: GitFork, rewind: RotateCcw,
  undo: Undo2, send: Send, stop: Square, check: Check, clock: Clock3, timer: AlarmClock, error: CircleAlert, failed: CircleX,
  file: File, "file-text": FileText, "file-search": FileSearch, image: Image, "image-plus": ImagePlus, terminal: Terminal,
  globe: Globe, agent: Bot, tasks: ListTodo, checklist: ListChecks, branch: GitBranch, paperclip: Paperclip,
  "circle-dot": CircleDot, "circle-check": CircleCheck, "circle-stop": CircleStop, help: CircleQuestionMark,
  keyboard: Keyboard, message: MessageSquare, external: ExternalLink, eye: Eye, trash: Trash, forbidden: Ban, loading: LoaderCircle,
  "arrow-down": ArrowDown, "arrow-up": ArrowUp, book: BookOpen, sliders: SlidersHorizontal, palette: Palette, user: UserRound, "key-round": KeyRound, braces: Braces,
};

export type IconName = keyof typeof icons;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const Glyph = icons[name];
  return <Glyph className={`ui-icon ${className}`} size={16} strokeWidth={1.75} aria-hidden="true" />;
}
