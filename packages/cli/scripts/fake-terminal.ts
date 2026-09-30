import type { Terminal } from "@voidkagami/tui";

export class FakeTerminal implements Terminal {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private _columns: number;
  private _rows: number;
  output = "";
  constructor(columns: number, rows = 40) { this._columns = columns; this._rows = rows; }
  start(onInput: (data: string) => void, onResize: () => void) { this.inputHandler = onInput; this.resizeHandler = onResize; }
  stop() { this.inputHandler = undefined; this.resizeHandler = undefined; }
  drainInput() { return Promise.resolve(); }
  write(data: string) { this.output += data; }
  get columns() { return this._columns; }
  get rows() { return this._rows; }
  get kittyProtocolActive() { return false; }
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  resize(columns: number, rows: number) { this._columns = columns; this._rows = rows; this.resizeHandler?.(); }
  feedInput(data: string) { for (const character of Array.from(data)) this.inputHandler?.(character); }
}
