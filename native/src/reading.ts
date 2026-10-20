import { restoreSectionPositions, type Projection } from "./projection";

type Method = (this: object, ...args: unknown[]) => unknown;
type Target = Record<string, unknown>;

/** The wrapper becomes inert on unload even if another plugin wrapped it later. */
export function wrapMethod(target: Target, key: string, wrapper: (original: Method, receiver: Target, args: unknown[]) => unknown): () => void {
  const original = target[key];
  if (typeof original !== "function") throw new Error(`Native method unavailable: ${key}`);
  let active = true;
  const replacement: Method = function (...args) {
    return active ? wrapper(original as Method, this as Target, args) : original.apply(this, args);
  };
  target[key] = replacement;
  return () => {
    active = false;
    if (target[key] === replacement) target[key] = original;
  };
}

/** Preserve the original renderer, worker, scheduling, source text and section
 * lifecycle. The native parse method receives a facade only for reading its
 * input and returning positions. Native methods called afterwards use the real
 * renderer. No note or editor text is temporarily replaced, even during awaits.
 */
export function installReadingAliases(
  rendererPrototype: Target,
  markdownRenderer: Target,
  project: (source: string) => Projection
): () => void {
  const disposers: Array<() => void> = [];
  for (const name of ["parseSync", "parseAsync", "parseFinish"]) {
    if (typeof rendererPrototype[name] !== "function") throw new Error(`Native reading parser unavailable: ${name}`);
  }
  if (typeof markdownRenderer.render !== "function") throw new Error("Native Markdown render method unavailable");
  const parse = (original: Method, renderer: Target, args: unknown[]) => {
    if (typeof renderer.text !== "string" || !/\\[([]/.test(renderer.text)) return original.apply(renderer, args);
    let input: Projection | undefined;
    const facade = new Proxy(renderer, {
      get(target, key) {
        if (key === "text") {
          input = project(String(target.text));
          return input.text;
        }
        if (key === "parseFinish") return (text: string, data: unknown) => {
          if (input?.text === text) {
            restoreSectionPositions(data, input);
            text = input.original;
          }
          return (target.parseFinish as Method).call(target, text, data);
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? (value as Method).bind(target) : value;
      },
      set: (target, key, value) => Reflect.set(target, key, value, target)
    });
    return original.apply(facade, args);
  };
  disposers.push(wrapMethod(rendererPrototype, "parseSync", parse));
  disposers.push(wrapMethod(rendererPrototype, "parseAsync", parse));
  disposers.push(wrapMethod(markdownRenderer, "render", (original, receiver, args) => {
    if (typeof args[1] === "string" && /\\[([]/.test(args[1])) {
      args = [...args];
      args[1] = project(args[1] as string).text;
    }
    return original.apply(receiver, args);
  }));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
