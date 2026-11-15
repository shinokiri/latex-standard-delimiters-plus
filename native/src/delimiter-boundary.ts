export function closingAt(source: string, from: number, closing: string): number {
  for (let at = from; at < source.length - 1; at++) {
    if (source[at] !== "\\") continue;
    if (source.slice(at, at + 2) === closing) return at;
    at++;
  }
  return -1;
}
