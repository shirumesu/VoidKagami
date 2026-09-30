import { accent, dim, gradient, gradientColor, isTrueColor, rgb } from "./theme.ts";

export const EMBLEM = [
  "   .-----.",
  "  /  .-.  \\",
  " |  (   )  |",
  "  \\  '-'  /",
  "   '-----'",
] as const;

export const WORDMARK = [
  "__   __  ___   ___   ___    _  __    _     ___     _     __  __   ___ ",
  "\\ \\ / / / _ \\ |_ _| |   \\  | |/ /   /_\\   / __|   /_\\   |  \\/  | |_ _|",
  " \\ V / | (_) | | |  | |) | | ' <   / _ \\ | (_ |  / _ \\  | |\\/| |  | | ",
  "  \\_/   \\___/ |___| |___/  |_|\\_\\ /_/ \\_\\ \\___| /_/ \\_\\ |_|  |_| |___|",
] as const;

function outerPositions(row: number, line: string): Set<number> {
  const positions = new Set<number>();
  if (row === 0 || row === 4) {
    for (let index = 0; index < line.length; index++) if (line[index] !== " ") positions.add(index);
  } else if (row === 1 || row === 3) { positions.add(line.indexOf("/")); positions.add(line.lastIndexOf("\\")); }
  else { positions.add(line.indexOf("|")); positions.add(line.lastIndexOf("|")); }
  return positions;
}

export function renderEmblem(): string[] {
  return EMBLEM.map((line, row) => {
    const outer = outerPositions(row, line);
    return Array.from(line, (char, index) => {
      if (char === " ") return char;
      if (outer.has(index)) return isTrueColor() ? rgb(char, gradientColor(row / (EMBLEM.length - 1))) : accent(char);
      return dim(char);
    }).join("");
  });
}

export function renderWordmark(): string[] {
  return WORDMARK.map((line) => Array.from(line, (char, index) => {
    if (char === " ") return char;
    return isTrueColor() ? rgb(char, gradientColor(index / 69)) : gradient(char, index / 69);
  }).join(""));
}
