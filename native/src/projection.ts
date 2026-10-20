import type { StringStream } from "@codemirror/language";
import { withStandardDelimiters, type NativeMode } from "./native-mode";

export type LegacyCodeMirror = {
  getMode(config: Record<string, unknown>, name: string | Record<string, unknown>): NativeMode;
  StringStream: new (line: string, tabSize?: number, oracle?: unknown) => StringStream;
};
type Replacement = { from: number; to: number; text: string };
export type Projection = {
  original: string;
  text: string;
  toOriginal(offset: number): number;
  originalLineStarts: number[];
};

/** A transient input alias for the host's reading parser. Recognition uses the
 * same host mode as the editor; code and other Markdown contexts stay literal.
 */
export function projectForNativeParser(source: string, cm: LegacyCodeMirror): Projection {
  const replacements: Replacement[] = [];
  if (/\\[([]/.test(source)) {
    const mode = withStandardDelimiters(cm.getMode({ tabSize: 4 }, "hypermd"));
    const state = mode.startState(4), lines = source.split("\n");
    let offset = 0, opening: { from: number; closing: string; dollar: string } | null = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.length) mode.blankLine?.(state);
      const stream = new cm.StringStream(line, 4, { lookAhead: (n: number) => lines[index + n] ?? null });
      for (let stalled = 0; stream.pos < line.length;) {
        const start = stream.pos, style = mode.token(stream, state)?.split(/\s+/) ?? [];
        const literal = line.slice(start, stream.pos);
        if (style.includes("formatting-math-begin")) {
          opening = literal === "\\(" ? { from: offset + start, closing: "\\)", dollar: "$" } :
            literal === "\\[" ? { from: offset + start, closing: "\\]", dollar: "$$" } : null;
        } else if (style.includes("formatting-math-end")) {
          if (opening && literal === opening.closing) {
            replacements.push({ from: opening.from, to: opening.from + 2, text: opening.dollar },
              { from: offset + start, to: offset + stream.pos, text: opening.dollar });
          }
          opening = null;
        }
        if (stream.pos === start) {
          if (++stalled > 10) throw new Error("Host Markdown mode did not advance");
        } else { stalled = 0; stream.start = stream.pos; }
      }
      offset += line.length + 1;
    }
  }
  let text = "", from = 0, removed = 0;
  const cuts: Array<{ at: number; removed: number }> = [];
  for (const replacement of replacements) {
    text += source.slice(from, replacement.from) + replacement.text;
    from = replacement.to;
    const change = replacement.to - replacement.from - replacement.text.length;
    if (change) {
      removed += change;
      cuts.push({ at: replacement.to - removed, removed });
    }
  }
  text += source.slice(from);
  const originalLineStarts = [0];
  for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", at + 1)) originalLineStarts.push(at + 1);
  return { original: source, text, originalLineStarts, toOriginal(offset) {
    let low = 0, high = cuts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cuts[middle].at <= offset) low = middle + 1; else high = middle;
    }
    return offset + (low ? cuts[low - 1].removed : 0);
  } };
}

export function restoreSectionPositions(data: unknown, projection: Projection): void {
  if (!data || typeof data !== "object" || !("sections" in data) || !Array.isArray(data.sections)) return;
  const sections: unknown[] = data.sections;
  for (const section of sections) {
    if (!section || typeof section !== "object" || !("pos" in section) ||
        !section.pos || typeof section.pos !== "object") continue;
    const positions = section.pos as Record<string, unknown>;
    for (const edge of ["start", "end"]) {
      const value = positions[edge];
      if (!value || typeof value !== "object") continue;
      const position = value as Record<string, unknown>;
      if (typeof position.offset !== "number") continue;
      const offset = projection.toOriginal(position.offset);
      position.offset = offset;
      if (typeof position.line === "number" && typeof position.col === "number" &&
          projection.originalLineStarts[position.line] !== undefined) {
        position.col = offset - projection.originalLineStarts[position.line];
      }
    }
  }
}
