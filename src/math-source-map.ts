import type { MathPresentation } from "./presentation";

type Token = { value: string; from: number; to: number };
type Span = { from: number; to: number };
type Entry = Span & { element: Element; leaf: boolean };
export type MathClick = { target: Element; x: number; y: number };
export type SourceHit = Span & { caret: number };

// MathJax expands these built-in relation macros into spacing + an arrow. Keep
// every expansion token attached to the original command's complete span. An
// overridden macro with different output will fail the normal alignment check.
const relationExpansions: Record<string, readonly string[]> = {
  "\\iff": ["\\;", "\\Longleftrightarrow", "\\;"],
  "\\implies": ["\\;", "\\Longrightarrow", "\\;"],
  "\\impliedby": ["\\;", "\\Longleftarrow", "\\;"]
};

/** Keep control sequences atomic, preserve Unicode offsets, and never search comments. */
function tokens(source: string): Token[] {
  const result: Token[] = [];
  for (const match of source.matchAll(/\\(?:[a-zA-Z]+|[^])|%[^\n]*|\s+|[^]/gu)) {
    if (/^(?:%|\s)/u.test(match[0])) continue;
    for (const value of relationExpansions[match[0]] ?? [match[0]]) result.push({value, from: match.index, to: match.index + match[0].length});
  }
  return result;
}

function children(element: Element): Element[] {
  const result: Element[] = [];
  function visit(parent: Element, depth: number): void {
    if (depth > 100) return;
    for (const child of Array.from(parent.children)) {
      if (child.matches("mjx-assistive-mml, mjx-speech, mjx-help")) continue;
      if (child.hasAttribute("data-latex")) result.push(child);
      else visit(child, depth + 1);
    }
  }
  visit(element, 0);
  return result;
}

function scriptSpans(input: Token[], span: Span): Map<string, Span> {
  const result = new Map<string, Span>();
  let depth = 0;
  for (let i = span.from; i < span.to; i++) {
    const value = input[i].value;
    if (value === "{") depth++;
    if (value === "}") depth--;
    if (depth || (value !== "^" && value !== "_")) continue;
    if (!result.size) result.set("base", {from: span.from, to: i});
    const from = i + 1;
    let to = from + 1;
    if (input[from]?.value === "{") {
      let nested = 1;
      while (to < span.to && nested) {
        if (input[to].value === "{") nested++;
        if (input[to].value === "}") nested--;
        to++;
      }
    }
    if (from < span.to && to <= span.to) result.set(value, {from, to});
    i = to - 1;
  }
  return result;
}

function scriptRole(parent: Element, child: Element): string {
  for (let node: Element | null = child; node && node !== parent; node = node.parentElement) {
    const tag = node.localName;
    if (tag === "mjx-over") return "^";
    if (tag === "mjx-under") return "_";
    if (tag === "mjx-script") {
      if (parent.localName === "mjx-msup") return "^";
      if (parent.localName === "mjx-msub") return "_";
      // CHTML puts the superscript above the spacer and the subscript below it.
      const parts = Array.from(node.children).filter(part => part.localName !== "mjx-spacer");
      return parts[0]?.contains(child) ? "^" : "_";
    }
  }
  return "base";
}

const cache = new WeakMap<HTMLElement, {source: string; entries: Entry[]}>();

/** Match whole TeX token sequences within their parent expressions. Accept an
 * ordered match only when forward and backward alignment agree. This makes
 * repeated symbols distinct without guessing at the first textual occurrence.
 * No global MathJax hooks, parser patches, or modified TeX are needed.
 */
function sourceEntries(root: HTMLElement, source: string): Entry[] {
  const cached = cache.get(root);
  if (cached?.source === source) return cached.entries;
  const entries: Entry[] = [];
  const input = tokens(source);
  cache.set(root, {source, entries});
  // Definitions can produce identical-looking, unrelated output. Their bodies
  // are not visible source occurrences; use the remembered caret instead.
  if (input.length > 8000 || input.some(token => /^\\(?:def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|DeclareMathOperator|csname|catcode)$/.test(token.value))) return entries;
  let budget = 250_000;
  function occurrences(pattern: Token[], span: Span): Span[] {
    const found: Span[] = [];
    if (!pattern.length) return found;
    outer: for (let at = span.from; at + pattern.length <= span.to; at++) {
      for (let n = 0; n < pattern.length; n++) {
        if (--budget < 0) return [];
        if (input[at + n].value !== pattern[n].value) continue outer;
      }
      found.push({from: at, to: at + pattern.length});
    }
    return found;
  }
  function visit(parent: Element, span: Span, depth: number): void {
    if (depth > 100 || budget < 0 || entries.length > 2000) return;
    const nodes = children(parent);
    if (!nodes.length) return;
    const scripts = /^mjx-m(?:subsup|sub|sup|underover|under|over)$/.test(parent.localName) ? scriptSpans(input, span) : new Map<string, Span>();
    const candidates = nodes.map(node => occurrences(tokens(node.getAttribute("data-latex") ?? ""), scripts.size ? scripts.get(scriptRole(parent, node)) ?? {from: 0, to: 0} : span));
    const selected: Array<Span | undefined> = [];
    if (scripts.size) {
      for (const options of candidates) selected.push(options.length === 1 ? options[0] : undefined);
    } else {
      // Reject the entire sibling alignment if any generated/expanded child
      // cannot be accounted for. Partial matches can point at unrelated tokens.
      let from = span.from, to = span.to;
      const earliest: Span[] = [], latest: Span[] = [];
      for (const options of candidates) {
        const next = options.find(option => option.from >= from);
        if (!next) return;
        earliest.push(next); from = next.to;
      }
      for (let i = candidates.length - 1; i >= 0; i--) {
        let next: Span | undefined;
        for (let j = candidates[i].length - 1; j >= 0; j--) if (candidates[i][j].to <= to) { next = candidates[i][j]; break; }
        if (!next) return;
        latest[i] = next; to = next.from;
      }
      for (let i = 0; i < nodes.length; i++) selected.push(earliest[i].from === latest[i].from ? earliest[i] : undefined);
    }
    nodes.forEach((node, i) => {
      const match = selected[i];
      if (!match || match.from === match.to) return;
      const descendants = children(node);
      entries.push({element: node, from: input[match.from].from, to: input[match.to - 1].to, leaf: descendants.length === 0});
      visit(node, match, depth + 1);
    });
  }
  const math = root.querySelector("mjx-math");
  if (math && input.length) visit(math, {from: 0, to: input.length}, 0);
  return entries;
}

export function invalidateSourceMap(root: HTMLElement): void { cache.delete(root); }

export function sourceHit(root: HTMLElement, source: string, click: MathClick): SourceHit | null {
  if (!root.contains(click.target) || click.target.closest("a, button, input, textarea, select, .interactive-child")) return null;
  const entries = sourceEntries(root, source);
  for (let node: Element | null = click.target; node && node !== root; node = node.parentElement) {
    const entry = entries.find(candidate => candidate.element === node);
    if (!entry) continue;
    let from = entry.from, to = entry.to, bounds = node.getBoundingClientRect();
    // Number/text glyphs can provide an exact character boundary. Commands are
    // kept atomic; horizontal proportions never map a whole formula to source.
    const glyphs = Array.from(node.querySelectorAll("mjx-c"));
    let literal = source.slice(from, to);
    const textArgument = /^\\(?:text|textrm|textit|textbf|operatorname\*?)\{([^{}\\]*)\}$/.exec(literal);
    if (textArgument) {
      from += literal.indexOf("{") + 1; to = from + textArgument[1].length;
      literal = textArgument[1];
    }
    if (entry.leaf && !literal.includes("\\") && glyphs.map(glyph => glyph.textContent?.normalize("NFKC") ?? "").join("") === literal) {
      const index = glyphs.findIndex(glyph => glyph === click.target || glyph.contains(click.target));
      if (index >= 0) {
        from += glyphs.slice(0, index).reduce((size, glyph) => size + (glyph.textContent?.normalize("NFKC").length ?? 0), 0);
        to = from + (glyphs[index].textContent?.normalize("NFKC").length ?? 0);
        bounds = glyphs[index].getBoundingClientRect();
      }
    }
    const caret = entry.leaf && bounds.width > 0 && click.x > bounds.left + bounds.width / 2 ? to : from;
    return {from, to, caret};
  }
  return null;
}

export function highlightSource(root: HTMLElement, source: string, position: number | null): void {
  const previous = root.querySelector(".lsd-math-focus");
  const entry = position === null ? undefined : sourceEntries(root, source)
    .filter(item => position >= item.from && position <= item.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from) || Number(b.from === position) - Number(a.from === position))[0];
  if (previous === entry?.element) return;
  previous?.classList.remove("lsd-math-focus");
  entry?.element.classList.add("lsd-math-focus");
}

/** Project between rendered TeX and Markdown without consuming quote/list prefixes. */
export function sourceToDocument(presentation: MathPresentation, position: number): number | null {
  for (const segment of presentation.segments) {
    const end = segment.sourceFrom + segment.to - segment.from;
    if (position >= segment.sourceFrom && position < end) return segment.from + position - segment.sourceFrom;
  }
  const last = presentation.segments[presentation.segments.length - 1];
  return last && position === presentation.source.length ? last.to : null;
}

export function documentToSource(presentation: MathPresentation, position: number): number | null {
  for (const segment of presentation.segments) if (position >= segment.from && position <= segment.to) return segment.sourceFrom + position - segment.from;
  return null;
}

export function firstSourcePosition(presentation: MathPresentation): number | null {
  return sourceToDocument(presentation, tokens(presentation.source)[0]?.from ?? 0);
}
