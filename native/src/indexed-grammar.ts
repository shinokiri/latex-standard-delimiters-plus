import { closingAt } from "./delimiter-boundary";

type Node = Record<string, unknown>;
type Frame = {
  eat(text: string): { apply(node: Node): unknown };
  [key: string]: unknown;
};
type Tokenizer = (parser: unknown, frame: Frame, source: string, silent?: boolean) => unknown;
type Rule = { fn: Tokenizer; block?: (first: number, nonspace: number) => boolean; chars?: string };
const installed = new WeakSet<Rule[][]>();

/** The 1.15.1 tokenizer takes an explicit parser/frame instead of a callable
 * eater. Capture its original math node without advancing the real frame,
 * then commit with the original source's delimiter lengths and positions.
 */
function alias(original: Tokenizer, block: boolean): Tokenizer {
  return (parser, frame, source, silent) => {
    const prefix = block ? /^( *)\\\[/.exec(source) : null;
    const start = block ? prefix?.[1].length : 0;
    if (start === undefined || block && !prefix) return;
    const opening = source.slice(start, start + 2);
    if (opening !== "\\[" && (block || opening !== "\\(")) return;
    const dollar = opening === "\\[" ? "$$" : "$";
    const closing = opening === "\\[" ? "\\]" : "\\)";
    const end = closingAt(source, start + 2, closing);
    if (end < 0 && !block) return;
    const virtual = source.slice(0, start) + dollar +
      (end < 0 ? source.slice(start + 2) : source.slice(start + 2, end) + dollar + source.slice(end + 2));
    let consumed = -1, node: Node | undefined;
    const buffer = Object.assign(Object.create(frame), {
      eat(text: string) {
        return { apply(value: Node) { consumed = text.length; node = value; return value; } };
      },
    }) as Frame;
    original(parser, buffer, virtual, false);
    const removed = 2 - dollar.length;
    if (!node || consumed < 0 || !block && consumed < end - removed + dollar.length) return;
    if (silent) return true;
    const length = consumed + (consumed > start ? removed : 0) +
      (end >= 0 && consumed >= end - removed + dollar.length ? removed : 0);
    return frame.eat(source.slice(0, length)).apply(node);
  };
}

/** Register only backslash aliases. Dollar dispatch and its original native
 * tokenizers remain intact. Interrupt tables cover paragraph/list boundaries.
 */
export function installIndexedGrammar(
  blocks: Rule[], inline: Rule[][], blockMath: Tokenizer, inlineMath: Tokenizer,
  interrupts: Tokenizer[][],
): void {
  if (installed.has(inline)) return;
  if (!Array.isArray(blocks) || !Array.isArray(inline) || inline.length !== 129 ||
      !inline.every(Array.isArray) || typeof blockMath !== "function" || typeof inlineMath !== "function" ||
      blocks.filter(rule => rule.fn === blockMath).length !== 1 ||
      !inline[36].some(rule => rule.fn === inlineMath) || inline[92].length === 0 ||
      !Array.isArray(interrupts) || interrupts.length === 0 ||
      !interrupts.every(table => Array.isArray(table) && table.includes(blockMath) && table.every(fn => typeof fn === "function"))) {
    throw new Error("Unsupported indexed Markdown grammar; native delimiter patch refused");
  }
  const block = alias(blockMath, true), span = alias(inlineMath, false);
  blocks.splice(blocks.findIndex(rule => rule.fn === blockMath), 0, {
    fn: block, block: (_first, nonspace) => nonspace === 92,
  });
  inline[92].unshift({ fn: span, chars: "\\" });
  for (const table of new Set(interrupts)) table.splice(table.indexOf(blockMath), 0, block);
  installed.add(inline);
}
