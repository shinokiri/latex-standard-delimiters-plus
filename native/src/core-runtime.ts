import { withStandardDelimiters, type NativeMode } from "./native-mode";

type MathNode = Record<string, unknown>;
type Eat = ((text: string) => (node: MathNode) => unknown) & Record<string, unknown>;
type Tokenizer = ((this: unknown, eat: Eat, value: string, silent?: boolean) => unknown) & {
  locator?: (value: string, from: number) => number;
};
type Grammar = {
  inlineTokenizers: Record<string, Tokenizer>;
  blockTokenizers: Record<string, Tokenizer>;
  inlineMethods: string[];
  blockMethods: string[];
  [key: string]: unknown;
};
type ParserConstructor = {prototype: Grammar};
const installed = new WeakSet<ParserConstructor>();
const name = "nativeStandardMath";

function closingAt(source: string, from: number, closing: string): number {
  for (let at = from; at < source.length - 1; at++) {
    if (source[at] !== "\\") continue;
    if (source.slice(at, at + 2) === closing) return at;
    at++;
  }
  return -1;
}

/** Let the original math tokenizer create its original node. Commit its
 * consumption against the real input so the host assigns original positions.
 * This also keeps metadata, tables, embeds and clipboard parsing in agreement.
 */
function alias(original: Tokenizer, block: boolean): Tokenizer {
  return function (eat, source, silent) {
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
    let consumed = -1, node: MathNode | undefined;
    const buffer = Object.assign((text: string) => (value: MathNode) => {
      consumed = text.length; node = value; return value;
    }, eat) as Eat;
    original.call(this, buffer, virtual, false);
    // Do not let an internal dollar close a standard-delimiter formula early.
    const removed = 2 - dollar.length;
    if (!node || consumed < 0 || !block && consumed < end - removed + dollar.length) return;
    if (silent) return true;
    const length = consumed + (consumed > start ? removed : 0) +
      (end >= 0 && consumed >= end - removed + dollar.length ? removed : 0);
    return eat(source.slice(0, length))(node);
  };
}

/** Called once from the application's central Markdown parse function.
 * Existing dollar rules and every native renderer remain unmodified.
 */
export function installGrammar(Parser: ParserConstructor): void {
  if (installed.has(Parser)) return;
  const grammar = Parser.prototype;
  if (typeof grammar.inlineTokenizers?.math !== "function" ||
      typeof grammar.blockTokenizers?.math !== "function" ||
      !grammar.inlineMethods?.includes("escape") || !grammar.blockMethods?.includes("math")) {
    throw new Error("Unsupported Obsidian Markdown grammar; native delimiter patch refused");
  }
  const inline = alias(grammar.inlineTokenizers.math, false);
  inline.locator = (source, from) => {
    const paren = source.indexOf("\\(", from), bracket = source.indexOf("\\[", from);
    return paren < 0 ? bracket : bracket < 0 ? paren : Math.min(paren, bracket);
  };
  grammar.inlineTokenizers[name] = inline;
  grammar.blockTokenizers[name] = alias(grammar.blockTokenizers.math, true);
  grammar.inlineMethods.splice(grammar.inlineMethods.indexOf("escape"), 0, name);
  grammar.blockMethods.splice(grammar.blockMethods.indexOf("math"), 0, name);
  for (const key of Object.keys(grammar)) {
    const interrupts = grammar[key];
    if (!key.startsWith("interrupt") || !Array.isArray(interrupts)) continue;
    const at = interrupts.findIndex(value => Array.isArray(value) && value[0] === "math");
    if (at >= 0) interrupts.splice(at, 0, [name, ...(interrupts[at] as unknown[]).slice(1)]);
  }
  installed.add(Parser);
}

export function wrapFactory(factory: (...args: unknown[]) => NativeMode) {
  return function (this: unknown, ...args: unknown[]): NativeMode {
    return withStandardDelimiters(factory.apply(this, args));
  };
}
