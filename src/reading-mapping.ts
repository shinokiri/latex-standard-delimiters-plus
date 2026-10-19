/** Map template text onto a rendered section without normalizing TeX contents.
 *
 * Rendering a list item as Markdown adds an outer list and its layout newlines.
 * The host can pass just the item's DOM. When both complete text bodies agree,
 * only their outer whitespace differs; the returned offset can be negative.
 * Partial matches remain exact and must be unique.
 */
export function readingSectionOffset(rendered: string, template: string): number | null {
  if (!template) return null;
  const at = rendered.indexOf(template);
  if (at !== -1 && at === rendered.lastIndexOf(template)) return at;
  const body = template.trim();
  if (!body || rendered.trim() !== body) return null;
  return (rendered.length - rendered.trimStart().length) -
    (template.length - template.trimStart().length);
}
