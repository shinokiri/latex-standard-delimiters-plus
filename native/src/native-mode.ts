import type { StringStream } from "@codemirror/language";

export type NativeState = Record<string, unknown> & {
  hmdInnerExitChecker?: ExitChecker | null;
};
type Exit = { endPos?: number; style?: string; skipInnerMode?: boolean };
type ExitChecker = (stream: StringStream, state: NativeState) => Exit | null;
type Boundary = {
  closing: string; dollar: string; nativeExit: ExitChecker;
  line?: string; from?: number; end?: number; virtual?: string;
};
const boundaries = new WeakMap<ExitChecker, Boundary>();
export type NativeMode = {
  name?: string;
  token(stream: StringStream, state: NativeState): string | null;
  startState(indentUnit?: number): NativeState;
  copyState(state: NativeState): NativeState;
  blankLine?(state: NativeState): string | null | undefined;
  [key: string]: unknown;
};

function closingAt(line: string, from: number, closing: string): number {
  for (let at = from; at < line.length - 1; at++) {
    if (line[at] !== "\\") continue;
    if (line.slice(at, at + 2) === closing) return at;
    at++;
  }
  return -1;
}

function prepareBoundary(boundary: Boundary, line: string, from: number): number {
  if (boundary.line === line && boundary.from! <= from && (boundary.end! < 0 || boundary.end! >= from)) return boundary.end!;
  const end = closingAt(line, from, boundary.closing);
  boundary.line = line; boundary.from = from; boundary.end = end;
  boundary.virtual = end < 0 ? line : line.slice(0, end) + boundary.dollar + line.slice(end + 2);
  return end;
}

/** Extend an existing host mode. All tokenization, math state and styles are
 * produced by the original dollar-math branch. Only its two boundary spellings
 * are adapted. This never changes an editor document or installs decorations.
 */
export function withStandardDelimiters(native: NativeMode): NativeMode {
  return {
    ...native,
    token(stream, state) {
      const start = stream.pos;
      const adaptedExit = state.hmdInnerExitChecker;
      const boundary = adaptedExit && boundaries.get(adaptedExit);
      if (boundary) {
        const line = stream.string, end = prepareBoundary(boundary, line, start);
        if (end < 0) return native.token(stream, state);
        const checker: ExitChecker = (input, innerState) => input.start === end ||
          innerState.hmdTable && input.string[input.start] === "|" ? boundary.nativeExit(input, innerState) : null;
        state.hmdInnerExitChecker = checker;
        try {
          stream.string = boundary.virtual!;
          return native.token(stream, state);
        } finally {
          if (stream.pos >= end + boundary.dollar.length) stream.pos += 2 - boundary.dollar.length;
          stream.string = line;
          if (state.hmdInnerExitChecker === checker) state.hmdInnerExitChecker = adaptedExit;
        }
      }
      const opening = stream.string.slice(start, start + 2);
      if (opening !== "\\(" && opening !== "\\[") return native.token(stream, state);
      const before = native.copyState(state);
      const originalStyle = native.token(stream, state);
      // Let the host decide whether this is ordinary Markdown. Code, front
      // matter, links, existing dollar math and escaped backslashes stay native.
      if (stream.pos !== start + 1 || !originalStyle?.split(/\s+/).includes("formatting-escape")) return originalStyle;
      const display = opening === "\\[", dollar = display ? "$$" : "$";
      const closing = display ? "\\]" : "\\)";
      const originalLine = stream.string, originalPosition = stream.pos;
      const end = closingAt(originalLine, start + 2, closing);
      const tail = end < 0 ? originalLine.slice(start + 2) :
        originalLine.slice(start + 2, end) + dollar + originalLine.slice(end + 2);
      let style: string | null = null, position = start;
      try {
        stream.string = originalLine.slice(0, start) + dollar + tail;
        stream.pos = start;
        for (let attempt = 0; attempt < 10 && stream.pos === start; attempt++) style = native.token(stream, before);
        position = stream.pos;
      } finally {
        stream.string = originalLine;
        stream.pos = originalPosition;
      }
      if (position !== start + dollar.length || !style?.split(/\s+/).includes("formatting-math-begin") ||
          typeof before.hmdInnerExitChecker !== "function") return originalStyle;
      const exit = before.hmdInnerExitChecker;
      before.hmdInnerExitChecker = (input, innerState) => {
        if (input.string.slice(input.start, input.start + 2) !== closing) {
          // Keep the host's table-cell boundary, but a literal dollar is not a
          // boundary of a standard-delimiter formula.
          return innerState.hmdTable && input.string[input.start] === "|" ? exit(input, innerState) : null;
        }
        const text = input.string;
        try {
          input.string = text.slice(0, input.start) + dollar + text.slice(input.start + 2);
          const result = exit(input, innerState);
          return result ? { ...result, endPos: input.start + 2 } : null;
        } finally { input.string = text; }
      };
      boundaries.set(before.hmdInnerExitChecker, {closing, dollar, nativeExit: exit});
      for (const key of Object.keys(state)) if (!Object.hasOwn(before, key)) delete state[key];
      Object.assign(state, before);
      stream.pos = start + 2;
      return style;
    }
  };
}
