import {
  Component,
  MarkdownRenderer,
  MarkdownRenderChild,
  editorLivePreviewField,
  finishRenderMath,
  loadMathJax,
  type MarkdownPostProcessorContext,
  type Editor,
  MarkdownView,
  TFile,
  Plugin,
  Notice,
  PluginSettingTab,
  type SettingDefinitionItem,
  renderMath
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { Facet, Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  WidgetType,
  ViewPlugin,
  keymap
} from "@codemirror/view";
import {
  findMathDelimiters,
  tableCellSources,
  type MathDelimiterMatch
} from "./parser";

import { diagnoseEquation } from "./diagnostics";
import { EquationDiagnosticModal } from "./diagnostics-modal";

import { mathTokens, matchingBraces } from "./highlight";
import { mathPresentation, containerReplacementRanges, type MathPresentation } from "./presentation";
import { readingSectionOffset } from "./reading-mapping";
import { registerMathActivation } from "./interaction";
import { displayLayout } from "./display-layout";
import { sourceHit, sourceToDocument, documentToSource, firstSourcePosition, highlightSource, invalidateSourceMap, type MathClick } from "./math-source-map";

const readingParseCache = new Map<string, MathDelimiterMatch[]>();
function readingMatches(text: string): MathDelimiterMatch[] {
  const cached = readingParseCache.get(text);
  if (cached) return cached;
  const matches = findMathDelimiters(text);
  if (text.length <= 2_000_000) {
    if (readingParseCache.size >= 2) { for (const key of readingParseCache.keys()) { readingParseCache.delete(key); break; } }
    readingParseCache.set(text, matches);
  }
  return matches;
}

const READING_RENDER_MARKER = "data-lsd-math-section";

function renderFormula(source: string, display: boolean, blockHost = display, ownerDocument = document): HTMLElement {
  const wrapper = ownerDocument.createElement(blockHost ? "div" : "span");
  wrapper.className = blockHost
    ? "lsd-math lsd-math-block"
    : "lsd-math lsd-math-inline";
  try {
    wrapper.appendChild(renderMath(source, display));
  } catch (error) {
    wrapper.textContent = display ? `\\[${source}\\]` : `\\(${source}\\)`;
    wrapper.classList.add("lsd-render-error");
    wrapper.title = `MathJax could not render this equation: ${String(error)}`;
  }
  return wrapper;
}

type RenderedCharacter = { node: Text; offset: number };

function renderedCharacters(element: HTMLElement, ignoreBlockSeparators = false): {
  text: string;
  characters: RenderedCharacter[];
} {
  let text = "";
  const characters: RenderedCharacter[] = [];

  function visit(node: Node): void {
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).matches("code, pre, .math, mjx-container, script, style, .lsd-math, .latex-delimiter-renderer")) {
      const boundary = element.ownerDocument.createTextNode("\u0000");
      text += boundary.data; characters.push({ node: boundary, offset: 0 });
      return;
    }
    if (node.instanceOf(Text)) {
      if (ignoreBlockSeparators && node.parentNode === element && /^\s*$/.test(node.data)) return;
      for (let offset = 0; offset < node.data.length; offset++) {
        text += node.data[offset];
        characters.push({ node, offset });
      }
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  }

  visit(element);
  return { text, characters };
}

const disabledRenderers = new WeakSet<Plugin>();
const renderScopes = new WeakMap<Plugin, Set<ReadingRenderScope>>();
const elementScopes = new WeakMap<HTMLElement, ReadingRenderScope>();
class ReadingRenderScope extends MarkdownRenderChild {
  active = true;
  mathActivations: Array<() => void> = [];
  replacements: Array<{ element: HTMLElement; original: DocumentFragment; key: string }> = [];
  constructor(element: HTMLElement, readonly context: MarkdownPostProcessorContext, readonly plugin: Plugin, readonly sourceRevision: string, public crossSection: boolean) { super(element); }
  onload(): void {
    this.active = true;
    let scopes = renderScopes.get(this.plugin);
    if (!scopes) { scopes = new Set(); renderScopes.set(this.plugin, scopes); }
    scopes.add(this); elementScopes.set(this.containerEl, this);
  }
  restore(): void {
    for (const dispose of this.mathActivations.splice(0)) dispose();
    for (const replacement of this.replacements) if (replacement.element.parentNode) replacement.element.replaceWith(replacement.original);
    this.replacements = [];
  }
  onunload(): void { this.active = false; this.restore(); renderScopes.get(this.plugin)?.delete(this); if (elementScopes.get(this.containerEl) === this) elementScopes.delete(this.containerEl); }
}

const embeddedElements = new WeakMap<HTMLElement, EmbeddedMathRenderChild>();

// Live Preview renders table cells and callout titles/bodies separately, often with
// no section metadata. Wait until their widget is attached, then recover the
// exact source fragment through CodeMirror's public DOM-position API.
class EmbeddedMathRenderChild extends MarkdownRenderChild {
  constructor(element: HTMLElement, private readonly context: MarkdownPostProcessorContext, private readonly plugin: Plugin) { super(element); embeddedElements.set(element, this); }
  onload(): void {
    const timerWindow = this.containerEl.ownerDocument.defaultView ?? window;
    let frame = 0, attempts = 0;
    this.register(() => { timerWindow.cancelAnimationFrame(frame); if (embeddedElements.get(this.containerEl) === this) embeddedElements.delete(this.containerEl); });
    const resolve = (): void => {
      const editor = this.containerEl.closest<HTMLElement>(".cm-editor");
      const view = editor ? EditorView.findFromDOM(editor) : null;
      if (!view) { if (++attempts < 10) frame = timerWindow.requestAnimationFrame(resolve); return; }
      let text: string | undefined;
      try {
        const position = view.posAtDOM(this.containerEl);
        const line = view.state.doc.lineAt(position);
        const cell = this.containerEl.closest<HTMLTableCellElement>("td, th");
        if (cell) {
          const row = cell.parentElement as HTMLTableRowElement;
          const rowNumber = line.number + (row.rowIndex === 0 ? 0 : row.rowIndex + 1);
          if (rowNumber > view.state.doc.lines) return;
          const rowSource = view.state.doc.line(rowNumber).text;
          const spans = tableCellSources(rowSource);
          if (spans.length !== row.cells.length) return;
          const span = spans[cell.cellIndex];
          if (span) text = rowSource.slice(span.from, span.to).trim();
        } else if (this.containerEl.closest(".callout-content")) {
          if (!/^ {0,3}>[ \t]?\[![^\]]+\]/.test(line.text)) return;
          const body: string[] = [];
          for (let number = line.number + 1; number <= view.state.doc.lines; number++) {
            const sourceLine = view.state.doc.line(number).text;
            if (!/^ {0,3}>/.test(sourceLine)) break;
            body.push(sourceLine.replace(/^ {0,3}>[ \t]?/, ""));
          }
          text = body.join("\n");
        } else if (this.containerEl.closest(".callout-title")) {
          text = line.text.replace(/^(?: {0,3}>[ \t]?)+\[![^\]]+\][+-]?[ \t]*/, "");
        }
      } catch { return; }
      if (!text) return;
      const section = { text, lineStart: 0, lineEnd: text.split("\n").length - 1 };
      const context: MarkdownPostProcessorContext = {
        docId: this.context.docId, sourcePath: this.context.sourcePath, frontmatter: this.context.frontmatter as unknown,
        addChild: child => this.context.addChild(child), getSectionInfo: () => section
      };
      void renderReadingView(this.containerEl, context, this.plugin).catch(error => console.error("Standard delimiters embedded rendering:", error));
    };
    frame = timerWindow.requestAnimationFrame(resolve);
  }
}

// Blank rows can split one display across multiple Reading View sections.
// Wait for both source-bound sections, then map only their common source span.
const crossSectionChildren = new WeakMap<Plugin, Set<CrossSectionMathChild>>();
const managedReadingContexts = new WeakSet<MarkdownPostProcessorContext>();
class CrossSectionMathChild extends MarkdownRenderChild {
  constructor(element: HTMLElement, private readonly context: MarkdownPostProcessorContext, private readonly plugin: Plugin, private readonly match: MathDelimiterMatch, private readonly sourceRevision: string) { super(element); }
  onload(): void {
    if (disabledRenderers.has(this.plugin)) return;
    let children = crossSectionChildren.get(this.plugin);
    if (!children) { children = new Set(); crossSectionChildren.set(this.plugin, children); }
    children.add(this);
    const timerWindow = this.containerEl.ownerDocument.defaultView ?? window;
    let frame = 0, attempts = 0, active = true, rendering = false, dirty = false;
    let observer: MutationObserver | undefined, watched: HTMLElement | undefined;
    let participants = [this.containerEl];
    const key = `${this.match.from}:${this.match.to}`;
    const isRendered = (): boolean => elementScopes.get(this.containerEl)?.replacements.some(replacement =>
      replacement.key === key && replacement.element.classList.contains("lsd-math") && this.containerEl.contains(replacement.element)) ?? false;
    this.register(() => { active = false; timerWindow.cancelAnimationFrame(frame); observer?.disconnect(); children.delete(this); });
    const schedule = (): void => {
      if (!active || disabledRenderers.has(this.plugin) || isRendered()) return;
      if (rendering) { dirty = true; return; }
      if (!frame) frame = timerWindow.requestAnimationFrame(resolve);
    };
    const resolve = (): void => {
      frame = 0;
      if (!active || disabledRenderers.has(this.plugin) || isRendered()) return;
      const parent = this.containerEl.parentElement;
      if (!parent || !parent.classList.contains("markdown-preview-section")) { if (++attempts < 20) schedule(); return; }
      (this.plugin as LatexDelimiterRenderer).watchReadingRemounts(this.containerEl, this.context);
      if (watched !== parent) {
        observer?.disconnect(); watched = parent;
        observer = new timerWindow.MutationObserver(records => {
          if (isRendered()) return;
          if (records.some(record => record.target === parent || participants.some(part => part.contains(record.target)))) {
            attempts = 0; schedule();
          }
        });
        observer.observe(parent, { childList: true, subtree: true, characterData: true });
      }
      const opening = this.context.getSectionInfo(this.containerEl);
      if (!opening) { if (++attempts < 20) schedule(); return; }
      if (opening.text !== this.sourceRevision) return;
      const starts = [0];
      for (let i = 0; i < opening.text.length; i++) if (opening.text[i] === "\n") starts.push(i + 1);
      const end = Array.from(parent.children).map(child => this.context.getSectionInfo(child as HTMLElement)).find(section => section && (starts[section.lineStart] ?? 0) <= this.match.to - 1 && (starts[section.lineEnd + 1] ?? opening.text.length) >= this.match.to);
      if (!end) { if (++attempts < 20) schedule(); return; }
      const section = { ...opening, lineEnd: end.lineEnd };
      const elements = Array.from(parent.children).filter(child => {
        if (child.classList.contains("mod-ui")) return false;
        const info = this.context.getSectionInfo(child as HTMLElement);
        return info && info.lineStart >= opening.lineStart && info.lineEnd <= end.lineEnd;
      }) as HTMLElement[];
      participants = elements;
      const scope = elementScopes.get(this.containerEl);
      if (scope?.sourceRevision === this.sourceRevision) {
        // A virtualized paragraph may drop just one equation fragment. Restore
        // surviving fragments and release detached copies before mapping again.
        scope.replacements = scope.replacements.filter(replacement => {
          if (replacement.key !== key && elements.some(element => element.contains(replacement.element))) return true;
          if (replacement.element.parentNode) replacement.element.replaceWith(replacement.original);
          return false;
        });
      }
      if (!elements.length || !renderedCharacters(elements[0]).text || !renderedCharacters(elements[elements.length - 1]).text) return;
      const context: MarkdownPostProcessorContext = { docId: this.context.docId, sourcePath: this.context.sourcePath, frontmatter: this.context.frontmatter as unknown, addChild: child => this.addChild(child), getSectionInfo: () => section };
      rendering = true;
      void renderReadingViewOnce(parent, context, this.plugin, this.match, elements, () => active && this.context.getSectionInfo(this.containerEl)?.text === section.text && elements.every(element => element.parentElement === parent))
        .catch(error => console.error("Standard delimiters cross-section rendering:", error))
        .finally(() => { rendering = false; if (dirty) { dirty = false; schedule(); } });
    };
    schedule();
  }
}

const readingTasks = new WeakMap<HTMLElement, { source: string | undefined; sourcePath: string; task: Promise<void> }>();
function renderReadingView(element: HTMLElement, context: MarkdownPostProcessorContext, plugin: Plugin): Promise<void> {
  const source = context.getSectionInfo(element)?.text;
  const existing = readingTasks.get(element);
  if (existing && existing.source === source && existing.sourcePath === context.sourcePath) return existing.task;
  const task = renderReadingViewOnce(element, context, plugin);
  const pending = { source, sourcePath: context.sourcePath, task };
  readingTasks.set(element, pending);
  void task.finally(() => { if (readingTasks.get(element) === pending) readingTasks.delete(element); }).catch(() => {});
  return task;
}

async function renderReadingViewOnce(
  element: HTMLElement,
  context: MarkdownPostProcessorContext,
  plugin: Plugin,
  crossSectionMatch?: MathDelimiterMatch,
  crossSectionElements?: HTMLElement[],
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (disabledRenderers.has(plugin) || element.closest(`[${READING_RENDER_MARKER}="template"]`)) return;

  const section = context.getSectionInfo(element);
  if (!section) { if (!embeddedElements.has(element)) context.addChild(new EmbeddedMathRenderChild(element, context, plugin)); return; }
  const lineStarts = [0];
  for (let i = 0; i < section.text.length; i++) if (section.text[i] === "\n") lineStarts.push(i + 1);
  const sectionStart = lineStarts[section.lineStart] ?? 0;
  const sectionEnd = lineStarts[section.lineEnd + 1] ?? section.text.length;
  const allMatches = readingMatches(section.text);
  if (!crossSectionMatch) {
    for (const match of allMatches) if (match.from >= sectionStart && match.from < sectionEnd && match.to > sectionEnd) context.addChild(new CrossSectionMathChild(element, context, plugin, match, section.text));
  }
  const matches = allMatches.filter(match => match.from >= sectionStart && match.to <= sectionEnd);
  if (matches.length === 0) return;
  // Register ownership before asynchronous template rendering. If the host
  // removes this section while we await, its teardown cancels the pending work.
  const scopeElement = crossSectionElements?.[0] ?? element;
  let scope = elementScopes.get(scopeElement);
  if (scope && (scope.sourceRevision !== section.text || scope.context.sourcePath !== context.sourcePath)) { scope.unload(); scope = undefined; }
  if (!scope) { scope = new ReadingRenderScope(scopeElement, context, plugin, section.text, !!crossSectionMatch); context.addChild(scope); }
  else if (crossSectionMatch) scope.crossSection = true;

  const fragments = (crossSectionElements ?? [element]).map(part => renderedCharacters(part));
  const rendered = { text: fragments.map(part => part.text).join(""), characters: fragments.flatMap(part => part.characters) };
  const replacements: Array<{
    from: number;
    to: number;
    match: MathDelimiterMatch;
  }> = [];

  // Render one marked template for the entire section. Rendering the same
  // section once per equation made dense callouts quadratic in their size.
  const template = element.ownerDocument.createElement("div");
  template.setAttribute(READING_RENDER_MARKER, "template");
  const component = new Component();
  component.load();
  try {
    let markerPrefix = "\uE000LSD";
    while (section.text.includes(markerPrefix)) markerPrefix += "\uE002";
    const markers = matches.map((match, index) => ({ match, start: `${markerPrefix}${index}START\uE001`, end: `${markerPrefix}${index}END\uE001` }));
    let markedSource = "", sourceAt = sectionStart;
    for (const marker of markers) {
      markedSource += section.text.slice(sourceAt, marker.match.from) + marker.start + section.text.slice(marker.match.from, marker.match.to) + marker.end;
      sourceAt = marker.match.to;
    }
    markedSource += section.text.slice(sourceAt, sectionEnd);
    await MarkdownRenderer.render(plugin.app, markedSource, template, context.sourcePath, component);
    const markedText = renderedCharacters(template, !!crossSectionMatch).text;
    const mapped: Array<{ from: number; to: number; visible: string; match: MathDelimiterMatch }> = [];
    let cleanText = "", markedAt = 0;
    for (const marker of markers) {
      const start = markedText.indexOf(marker.start, markedAt);
      const end = start < 0 ? -1 : markedText.indexOf(marker.end, start + marker.start.length);
      // A missing marker makes the mapping untrustworthy; leave this section literal.
      if (start < 0 || end < 0) return;
      cleanText += markedText.slice(markedAt, start);
      const visible = markedText.slice(start + marker.start.length, end);
      const from = cleanText.length;
      cleanText += visible;
      mapped.push({ from, to: cleanText.length, visible, match: marker.match });
      markedAt = end + marker.end.length;
    }
    cleanText += markedText.slice(markedAt);
    const wholeSectionAt = readingSectionOffset(rendered.text, cleanText);
    for (const mapping of mapped) {
      if (!mapping.visible) continue;
      if (wholeSectionAt !== null) {
        replacements.push({ from: wholeSectionAt + mapping.from, to: wholeSectionAt + mapping.to, match: mapping.match });
      } else {
        // A partial mapping must be unique on both sides: an already completed
        // nested processor can otherwise leave only a literal lookalike.
        const from = rendered.text.indexOf(mapping.visible);
        if (from !== -1 && from === rendered.text.lastIndexOf(mapping.visible) && cleanText.indexOf(mapping.visible) === cleanText.lastIndexOf(mapping.visible)) {
          replacements.push({ from, to: from + mapping.visible.length, match: mapping.match });
        }
      }
    }
  } finally { component.unload(); }

  if (disabledRenderers.has(plugin) || !scope.active || !isCurrent() || context.getSectionInfo(element)?.text !== section.text || replacements.length === 0) return;
  replacements.sort((left, right) => right.from - left.from);
  for (const replacement of replacements) {
    const first = rendered.characters[replacement.from];
    const last = rendered.characters[replacement.to - 1];
    if (!first || !last || !element.contains(first.node) || !element.contains(last.node) || first.offset >= first.node.length || last.offset >= last.node.length) continue;

    const range = element.ownerDocument.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    // Another nested processor may have completed while the template was awaited.
    if (range.toString() !== rendered.text.slice(replacement.from, replacement.to)) continue;
    const original = range.cloneContents();
    const acrossParents = first.node.parentElement !== last.node.parentElement;
    const pieces: Array<{ node: Text; from: number; to: number }> = [];
    if (acrossParents) {
      for (const character of rendered.characters.slice(replacement.from, replacement.to)) {
        const previous = pieces[pieces.length - 1];
        if (previous?.node === character.node) previous.to = character.offset + 1;
        else pieces.push({ node: character.node, from: character.offset, to: character.offset + 1 });
      }
    } else range.deleteContents();
    const presentation = mathPresentation(section.text, replacement.match);
    const math = renderFormula(presentation.source, replacement.match.display, replacement.match.display, element.ownerDocument);
    if (element.closest(".cm-callout .callout-content")) {
      const currentView = () => {
        const editor = element.closest<HTMLElement>(".cm-editor");
        return editor ? EditorView.findFromDOM(editor) : null;
      };
      scope.mathActivations.push(registerMathActivation(math, () => currentView()?.composing ?? true, click => {
        const view = currentView();
        const widget = element.closest<HTMLElement>(".cm-callout");
        if (!view || !widget || !scope.active) return;
        activateMath(view, math, presentation.source, click, () => {
          const bounds = calloutSourceBounds(view, widget);
          if (!bounds || !scope.active) return;
          const candidates = parsedMatches(view.state).filter(candidate => candidate.from >= bounds.from && candidate.to <= bounds.to);
          const sourceOrder = [...replacements].sort((left, right) => left.match.from - right.match.from);
          const candidate = candidates[sourceOrder.indexOf(replacement)];
          return candidates.length === sourceOrder.length ? candidate : undefined;
        }, true);
      }));
    }
    if (acrossParents) {
      // Replace each text fragment separately so unload restores the original
      // paragraph/list structure, rather than nesting cloned blocks in a paragraph.
      for (let index = pieces.length - 1; index >= 0; index--) {
        const piece = pieces[index];
        const local = element.ownerDocument.createRange();
        local.setStart(piece.node, piece.from); local.setEnd(piece.node, piece.to);
        const saved = local.cloneContents(); local.deleteContents();
        const placeholder = index === 0 ? math : element.ownerDocument.createElement("span");
        local.insertNode(placeholder); scope.replacements.push({ element: placeholder, original: saved, key: `${replacement.match.from}:${replacement.match.to}` });
      }
    } else {
      range.insertNode(math);
      scope.replacements.push({ element: math, original, key: `${replacement.match.from}:${replacement.match.to}` });
    }
  }
  await finishRenderMath();
}

/** The native callout edit button is a host DOM convention, verified on 1.13.7. */
function calloutSourceBounds(view: EditorView, widget: HTMLElement): { from: number; to: number; headerFrom: number } | null {
  try {
    const line = view.state.doc.lineAt(view.posAtDOM(widget));
    if (!/^ {0,3}>[ \t]?\[![^\]]+\]/.test(line.text)) return null;
    let to = line.to;
    for (let number = line.number + 1; number <= view.state.doc.lines; number++) {
      const bodyLine = view.state.doc.line(number);
      if (!/^ {0,3}>/.test(bodyLine.text)) break;
      to = bodyLine.to;
    }
    return { from: Math.min(line.to + 1, view.state.doc.length), to, headerFrom: line.from };
  } catch { return null; }
}

const refreshEmbedded = Facet.define<() => void, (() => void) | undefined>({ combine: callbacks => callbacks.at(-1) });

// Native callout/table widgets appear after the editor transaction. React to
// their insertion instead of waiting for the renderer-conflict polling timer.
const embeddedWidgetObserver = ViewPlugin.fromClass(class {
  private observer: MutationObserver;
  private frame = 0;
  private destroyed = false;
  private timerWindow: Window;
  constructor(private view: EditorView) {
    this.timerWindow = view.dom.ownerDocument.defaultView ?? window;
    const Observer = view.dom.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
    const widgets = ".cm-callout, .callout-content, .callout-title-inner, .cm-table-widget, td, th";
    this.observer = new Observer(records => {
      if (records.some(record => Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(node => {
        if (node.nodeType !== 1) return false;
        const element = node as Element;
        return element.matches(widgets) || !!element.querySelector(widgets);
      }))) this.schedule();
    });
    this.observer.observe(view.dom, { childList: true, subtree: true });
    this.schedule();
  }
  private schedule(): void {
    if (this.frame || this.destroyed) return;
    this.frame = this.timerWindow.requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.destroyed) this.view.state.facet(refreshEmbedded)?.();
    });
  }
  destroy(): void {
    this.destroyed = true; this.observer.disconnect();
    if (this.frame) this.timerWindow.cancelAnimationFrame(this.frame);
  }
});

const pendingCalloutCarets = new WeakMap<EditorView, { position: number; headerFrom: number; to: number; doc: EditorState["doc"]; expires: number }>();

function revealContainingCallout(view: EditorView, position: number): void {
  if (view.composing) return;
  for (const widget of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-callout"))) {
    const bounds = calloutSourceBounds(view, widget);
    if (bounds && position >= bounds.from && position <= bounds.to) {
      const button = widget.querySelector<HTMLElement>(".edit-block-button");
      if (!button) return;
      pendingCalloutCarets.set(view, { position, headerFrom: bounds.headerFrom, to: bounds.to, doc: view.state.doc, expires: Date.now() + 500 });
      button.click();
      return;
    }
  }
}

// Obsidian's edit control asynchronously selects its entire callout. Observe
// that exact transaction instead of guessing when the native callback runs.
const calloutCaretObserver = ViewPlugin.fromClass(class {
  private destroyed = false;
  constructor(private view: EditorView) {}
  update(): void {
    const pending = pendingCalloutCarets.get(this.view);
    if (!pending) return;
    const selection = this.view.state.selection.main;
    if (Date.now() > pending.expires || this.view.state.doc !== pending.doc || this.view.composing || !this.view.state.facet(renderOptions).enabled || this.view.state.selection.ranges.length !== 1) {
      pendingCalloutCarets.delete(this.view); return;
    }
    if (selection.empty && selection.head === pending.position) return;
    if (selection.from !== pending.headerFrom || (selection.to !== pending.to && selection.to !== pending.to + 1)) {
      pendingCalloutCarets.delete(this.view); return;
    }
    queueMicrotask(() => {
      if (this.destroyed || pendingCalloutCarets.get(this.view) !== pending) return;
      if (!this.view.dom.isConnected || this.view.state.doc !== pending.doc || this.view.composing) { pendingCalloutCarets.delete(this.view); return; }
      // The first native selection may occur synchronously, before our caller
      // sets the math caret. Keep the guard for the later DOM-selection flush.
      if (!this.view.state.selection.main.eq(selection)) return;
      pendingCalloutCarets.delete(this.view);
      this.view.dispatch({ selection: { anchor: pending.position }, scrollIntoView: true });
      this.view.focus();
    });
  }
  destroy(): void { this.destroyed = true; pendingCalloutCarets.delete(this.view); }
});

function equationEditingRange(state: EditorState, match: MathDelimiterMatch, presentation = mathPresentation(state.doc.toString(), match)): { from: number; to: number } {
  // A tap on indentation, a quote marker or trailing whitespace still edits
  // this standalone display. Do not extend inline equations into nearby prose.
  return presentation.standalone
    ? { from: state.doc.lineAt(match.from).from, to: state.doc.lineAt(match.to).to }
    : match;
}

function rangeTouchesSelection(state: EditorState, match: MathDelimiterMatch, presentation?: MathPresentation): boolean {
  const bounds = equationEditingRange(state, match, presentation);
  return state.selection.ranges.some((range) => {
    if (range.empty) {
      return range.from >= bounds.from && range.from <= bounds.to;
    }
    return range.from < bounds.to && range.to > bounds.from;
  });
}

const mathActivations = new WeakMap<HTMLElement, () => void>();
const previewSources = new WeakMap<HTMLElement, {source: string; valid: boolean; identity: object}>();

function activateMath(view: EditorView, element: HTMLElement, source: string, click: MathClick, resolve: () => MathDelimiterMatch | undefined, keepScreenPosition: boolean): void {
  // Preserve the gesture target until all native input has been read. Resolve
  // document offsets only afterwards: committing IME can move this formula.
  const selectionAtClick = view.state.selection;
  view.requestMeasure({key: element,
    read: () => {
      const hit = sourceHit(element, source, click);
      const rect = click.target.getBoundingClientRect();
      const scroller = view.scrollDOM.getBoundingClientRect();
      const margin = Math.max(0, Math.min(rect.top - scroller.top, view.scrollDOM.clientHeight - view.defaultLineHeight * 2));
      return {hit, margin: keepScreenPosition && rect.height > 0 && scroller.height > 0 ? margin : null};
    },
    write: result => queueMicrotask(() => {
      if (!element.isConnected || view.composing) return;
      // A user who has already moved the source caret owns its new position.
      // Pending text input may legitimately change the selection during flush.
      if (element.classList.contains("lsd-editing-preview") && !view.state.selection.eq(selectionAtClick)) return;
      const match = resolve();
      if (!match) return;
      const presentation = mathPresentation(view.state.doc.toString(), match);
      if (presentation.source !== source) return; // Never navigate from a stale preview.
      const remembered = view.state.field(mathCaretMemory, false)?.find(item => item.from === match.from && item.to === match.to)?.head;
      const current = view.state.selection.main;
      const head = result.hit ? sourceToDocument(presentation, result.hit.caret) :
        current.empty && current.head >= match.from + 2 && current.head <= match.to - 2 ? current.head : remembered;
      const anchor = head ?? firstSourcePosition(presentation) ?? match.from + 2;
      revealContainingCallout(view, anchor);
      const effect = EditorView.scrollIntoView(anchor, result.margin === null ? {y: "nearest"} : {y: "start", yMargin: result.margin});
      view.dispatch({selection: {anchor}, effects: effect});
      view.focus();
    })
  });
}

class MathWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly display: boolean,
    private readonly block: boolean,
    private readonly standalone = false
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.source === other.source &&
      this.display === other.display &&
      this.block === other.block &&
      this.standalone === other.standalone
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const element = renderFormula(this.source, this.display, this.block, view.dom.ownerDocument);
    if (this.display && !this.block && this.standalone) element.classList.add("lsd-math-container-display");
    const reveal = (click: MathClick) => activateMath(view, element, this.source, click, () => {
        const position = view.posAtDOM(element);
        return parsedMatches(view.state).find(candidate => candidate.from === position);
      }, true);
    mathActivations.set(element, registerMathActivation(element, () => view.composing, reveal));
    queueMicrotask(() => { void finishRenderMath().then(() => { if (element.isConnected) view.requestMeasure(); }); });
    return element;
  }

  destroy(element: HTMLElement): void {
    mathActivations.get(element)?.();
    mathActivations.delete(element);
  }
  // Keep WidgetType's default ignoreEvent(true). MathJax text/selection/input
  // events are not editable Markdown; our own click handler reveals the source.
}

class EditingPreviewWidget extends WidgetType {
  constructor(private readonly source: string, private readonly display: boolean, private readonly identity: object) { super(); }
  eq(other: EditingPreviewWidget): boolean { return this.source === other.source && this.display === other.display && this.identity === other.identity; }
  toDOM(view: EditorView): HTMLElement {
    const element = renderFormula(this.source, this.display, true, view.dom.ownerDocument);
    element.classList.add("lsd-editing-preview");
    element.setAttribute("aria-label", "Equation preview");
    previewSources.set(element, {source: this.source, valid: !hasMathError(element), identity: this.identity});
    mathActivations.set(element, registerMathActivation(element, () => view.composing, click => {
      const rendered = previewSources.get(element);
      if (!rendered?.valid || element.classList.contains("lsd-preview-stale")) return;
      activateMath(view, element, rendered.source, click, () => {
        const selected = view.state.selection.main;
        return parsedMatches(view.state).find(match => {
          const bounds = equationEditingRange(view.state, match);
          return selected.from >= bounds.from && selected.to <= bounds.to && view.state.doc.lineAt(match.to).to === view.posAtDOM(element);
        });
      }, false);
    }));
    queueMicrotask(() => { void finishRenderMath().then(() => { if (element.isConnected) view.requestMeasure(); }); });
    return element;
  }

  updateDOM(element: HTMLElement, view: EditorView): boolean {
    const replacement = renderFormula(this.source, this.display, true, view.dom.ownerDocument);
    const valid = !hasMathError(replacement);
    const previous = previewSources.get(element);
    const stale = !valid && !!previous?.valid && previous.identity === this.identity;
    element.classList.toggle("lsd-preview-stale", stale);
    if (stale) {
      element.setAttribute("aria-label", "Equation preview: last valid result; current source is incomplete");
      element.title = "Last valid preview; current formula is incomplete";
    }
    else {
      element.setAttribute("aria-label", "Equation preview");
      element.removeAttribute("title");
      element.classList.toggle("lsd-render-error", !valid);
      element.replaceChildren(...Array.from(replacement.childNodes));
      previewSources.set(element, {source: this.source, valid, identity: this.identity});
      invalidateSourceMap(element);
    }
    queueMicrotask(() => { void finishRenderMath().then(() => { if (element.isConnected) view.requestMeasure(); }); });
    return true;
  }

  destroy(element: HTMLElement): void {
    mathActivations.get(element)?.(); mathActivations.delete(element);
    previewSources.delete(element);
  }
}

function hasMathError(element: HTMLElement): boolean {
  return element.classList.contains("lsd-render-error") || !!element.querySelector("mjx-merror, [data-mjx-error], .mjx-merror");
}

class LiteralMarkerWidget extends WidgetType {
  constructor(private readonly marker: string) {
    super();
  }

  eq(other: LiteralMarkerWidget): boolean {
    return this.marker === other.marker;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement("span");
    const kind = this.marker === "\\" || /[()[\]]/.test(this.marker) ? "delimiter" : "operator";
    element.className = `lsd-math-source-marker lsd-token-${kind}`;
    element.textContent = this.marker;
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function markdownFormattingMarkersInMath(
  state: EditorState,
  match: MathDelimiterMatch
): Array<{ from: number; to: number; text: string }> {
  const markers: Array<{ from: number; to: number; text: string }> = [];

  syntaxTree(state).iterate({
    from: match.from,
    to: match.to,
    enter(node) {
      if (
        (node.name.includes("formatting-em") ||
          node.name.includes("formatting-strong") ||
          node.name.includes("formatting-escape")) &&
        node.from >= match.from &&
        node.to <= match.to
      ) {
        markers.push({
          from: node.from,
          to: node.to,
          text: state.doc.sliceString(node.from, node.to)
        });
      }
      return true;
    }
  });

  // Syntax nodes may share ranges. Never insert two widgets for one character.
  return markers.filter((marker, index) => !markers.slice(0, index).some(previous =>
    marker.from < previous.to && marker.to > previous.from));
}

function lowerBound(values: number[], position: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < position) low = middle + 1; else high = middle; }
  return low;
}

const spillCache = new WeakMap<object, { tree: ReturnType<typeof syntaxTree>; spills: Array<{ from: number; to: number }> }>();
function emphasisSpills(state: EditorState, matches: MathDelimiterMatch[]): Array<{ from: number; to: number }> {
  const tree = syntaxTree(state);
  const cached = spillCache.get(state.doc);
  if (cached?.tree === tree) return cached.spills;
  const emphasis: number[] = [], strong: number[] = [];
  tree.iterate({ enter(node) {
    if (node.name.includes("formatting-em")) emphasis.push(node.from);
    if (node.name.includes("formatting-strong")) strong.push(node.from);
  } });
  const breaks = [...state.doc.toString().matchAll(/\n[\t ]*\n/g)].map(match => match.index);
  const spills: Array<{ from: number; to: number }> = [];
  for (const match of matches) {
    const paragraphEnd = breaks[lowerBound(breaks, match.to)] ?? state.doc.length;
    for (const markers of [emphasis, strong]) {
      const start = lowerBound(markers, match.from), end = lowerBound(markers, match.to);
      if ((end - start) % 2 === 0) continue;
      const spillEnd = Math.min(markers[end] ?? paragraphEnd, paragraphEnd);
      if (spillEnd > match.to) spills.push({ from: match.to, to: spillEnd });
    }
  }
  spillCache.set(state.doc, { tree, spills });
  return spills;
}

const renderOptions = Facet.define<{ previews: boolean; enabled: boolean }, { previews: boolean; enabled: boolean }>({
  combine: values => values[0] ?? { previews: true, enabled: true }
});
const parsedDocuments = new WeakMap<object, MathDelimiterMatch[]>();
function parsedMatches(state: EditorState): MathDelimiterMatch[] {
  let matches = parsedDocuments.get(state.doc);
  if (!matches) {
    matches = findMathDelimiters(state.doc.toString());
    parsedDocuments.set(state.doc, matches);
  }
  return matches;
}

// Per-editor bookmarks follow document changes and are discarded if their
// equation disappears. Identical formulas remain distinct; nothing is saved
// into notes or plugin settings. Bound memory to the most recent 64 equations.
const mathCaretMemory = StateField.define<Array<{from: number; to: number; head: number}>>({
  create(state) {
    const selection = state.selection.main;
    const match = state.selection.ranges.length === 1 && selection.empty ? parsedMatches(state).find(candidate => selection.head >= candidate.from + 2 && selection.head <= candidate.to - 2) : undefined;
    return match ? [{from: match.from, to: match.to, head: selection.head}] : [];
  },
  update(previous, transaction) {
    const matches = parsedMatches(transaction.state);
    let entries = transaction.docChanged ? previous.map(item => ({
      from: transaction.changes.mapPos(item.from, 1), to: transaction.changes.mapPos(item.to, -1), head: transaction.changes.mapPos(item.head, 1)
    })).filter(item => matches.some(match => match.from === item.from && match.to === item.to) && item.head >= item.from + 2 && item.head <= item.to - 2) : previous;
    const selection = transaction.state.selection.main;
    if (transaction.state.selection.ranges.length === 1 && selection.empty) {
      const match = matches.find(candidate => selection.head >= candidate.from + 2 && selection.head <= candidate.to - 2);
      if (match) entries = [...entries.filter(item => item.from !== match.from), {from: match.from, to: match.to, head: selection.head}].slice(-64);
    }
    return entries;
  }
});

const mathPreviewFocus = ViewPlugin.fromClass(class {
  private destroyed = false;
  constructor(private view: EditorView) { this.schedule(); }
  update(update: ViewUpdate): void { if (update.docChanged || update.selectionSet || update.transactions.some(transaction => transaction.effects.length)) this.schedule(); }
  private schedule(): void {
    this.view.requestMeasure({key: this, read: () => null, write: () => {
      if (this.destroyed) return;
      const state = this.view.state, selection = state.selection.main;
      const match = parsedMatches(state).find(candidate => selection.empty && selection.head >= candidate.from + 2 && selection.head <= candidate.to - 2);
      const presentation = match ? mathPresentation(state.doc.toString(), match) : null;
      for (const element of Array.from(this.view.dom.querySelectorAll<HTMLElement>(".lsd-editing-preview"))) {
        const rendered = previewSources.get(element);
        const current = rendered?.valid && presentation?.source === rendered.source && !state.field(compositionState, false);
        highlightSource(element, rendered?.source ?? "", current && presentation ? documentToSource(presentation, selection.head) : null);
      }
    }});
  }
  destroy(): void { this.destroyed = true; }
});

const setComposing = StateEffect.define<boolean>();
const compositionState = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    // The first DOM input can arrive before the deferred start notification.
    if (transaction.isUserEvent("input.type.compose")) value = true;
    for (const effect of transaction.effects) if (effect.is(setComposing)) value = effect.value;
    return value;
  }
});
const compositionEvents = ViewPlugin.fromClass(class {
  private destroyed = false;
  constructor(private readonly view: EditorView) {}
  update(update: ViewUpdate): void {
    if (update.transactions.some(transaction => transaction.isUserEvent("input.type.compose"))) this.schedule();
  }
  schedule(): void {
    // A synchronous dispatch clears CodeMirror's unread DOM mutations. A
    // microtask queued by compositionend can also run before the final input's
    // delayed observer flush on Android. CodeMirror flushes pending input at
    // the start of its measurement cycle. Use that public scheduling API, then
    // dispatch after the cycle (updates are forbidden inside read/write).
    this.view.requestMeasure({
      key: this, read: () => null,
      write: () => queueMicrotask(() => {
        if (this.destroyed || !this.view.dom.isConnected) return;
        const composing = this.view.hasFocus && this.view.compositionStarted;
        if (composing !== this.view.state.field(compositionState)) this.view.dispatch({ effects: setComposing.of(composing) });
      })
    });
  }
  destroy(): void { this.destroyed = true; }
}, {
  eventObservers: {
    compositionstart() { this.schedule(); }, compositionend() { this.schedule(); },
    focus() { this.schedule(); }, blur() { this.schedule(); }
  }
});

// Obsidian's Vim normal mode marks the scroller with cm-vimMode. Keep
// complete source visible there so native motions, counts and macros retain
// logical lines. Do not intercept Vim keys or access its private state.
const setVimSource = StateEffect.define<boolean>();
const vimSourceState = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setVimSource)) value = effect.value;
    return value;
  }
});
const vimSourceObserver = ViewPlugin.fromClass(class {
  private destroyed = false;
  private queued = false;
  private observer: MutationObserver;
  constructor(private view: EditorView) {
    const Observer = view.dom.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
    this.observer = new Observer(() => this.refresh());
    this.observer.observe(view.scrollDOM, { attributes: true, attributeFilter: ["class"] });
    this.refresh();
  }
  private refresh(): void {
    if (this.queued || this.destroyed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.destroyed) return;
      const active = this.view.scrollDOM.classList.contains("cm-vimMode");
      if (active !== this.view.state.field(vimSourceState)) this.view.dispatch({ effects: setVimSource.of(active) });
    });
  }
  destroy(): void { this.destroyed = true; this.observer.disconnect(); }
});

type EditingPreview = { from: number; to: number; equationFrom: number; equationTo: number; identity: object; at: number; source: string; display: boolean; standalone: boolean };

function canShowEditingPreview(state: EditorState): boolean {
  const options = state.facet(renderOptions);
  return options.enabled && options.previews && !!state.field(editorLivePreviewField, false) &&
    !state.field(vimSourceState, false) && state.selection.ranges.length === 1;
}

function selectionInsideEquation(state: EditorState, bounds: { from: number; to: number }, standalone: boolean): boolean {
  const selection = state.selection.main;
  // Triple-click/select-line includes the trailing newline. It is still a
  // selection of this equation, as long as it contains no neighbouring prose.
  const end = bounds.to + (!selection.empty && standalone && state.doc.sliceString(bounds.to, bounds.to + 1) === "\n" ? 1 : 0);
  return selection.from >= bounds.from && selection.from <= bounds.to && selection.to <= end;
}

function selectedEditingPreview(state: EditorState): EditingPreview | null {
  if (!canShowEditingPreview(state)) return null;
  const text = state.doc.toString();
  for (const match of parsedMatches(state)) {
    const presentation = mathPresentation(text, match);
    const bounds = equationEditingRange(state, match, presentation);
    if (selectionInsideEquation(state, bounds, presentation.standalone)) {
      return { ...bounds, equationFrom: match.from, equationTo: match.to, identity: {}, at: state.doc.lineAt(match.to).to, source: presentation.source, display: match.display, standalone: presentation.standalone };
    }
  }
  return null;
}

const editingPreviewState = StateField.define<EditingPreview | null>({
  create: selectedEditingPreview,
  update(previous, transaction) {
    const state = transaction.state;
    if (!canShowEditingPreview(state)) return null;
    if (state.field(compositionState, false) && previous) {
      const from = transaction.changes.mapPos(previous.from, -1);
      const to = transaction.changes.mapPos(previous.to, 1);
      // Android can start a composition merely from tapping a word. Keep the
      // existing preview stable only while editing that same equation. If a
      // tap enters an equation after composition already started, initialize
      // its first preview instead of freezing the previous absence of one.
      if (selectionInsideEquation(state, { from, to }, previous.standalone)) {
        return { ...previous, from, to,
          equationFrom: transaction.changes.mapPos(previous.equationFrom, 1), equationTo: transaction.changes.mapPos(previous.equationTo, -1),
          at: state.doc.lineAt(transaction.changes.mapPos(previous.at, 1)).to };
      }
    }
    const selected = selectedEditingPreview(state);
    // Stable identity follows this equation through edits, not its numeric
    // position or TeX text. Switching equations must never reuse a stale result.
    if (previous && selected && selected.equationFrom === transaction.changes.mapPos(previous.equationFrom, 1) && selected.equationTo === transaction.changes.mapPos(previous.equationTo, -1)) selected.identity = previous.identity;
    return selected;
  }
});

function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  const options = state.facet(renderOptions);
  if (!options.enabled || !state.field(editorLivePreviewField, false)) return Decoration.none;
  const matches = parsedMatches(state);
  const documentText = state.doc.toString();
  const composing = state.field(compositionState, false) === true;
  const vimSource = state.field(vimSourceState, false) === true;
  const ranges: ReturnType<Decoration["range"]>[] = [];

  for (const spill of emphasisSpills(state, matches)) {
    ranges.push(Decoration.mark({ class: "lsd-math-emphasis-spill" }).range(spill.from, spill.to));
  }
  for (const match of matches) {
    const presentation = mathPresentation(documentText, match);
    if (vimSource || rangeTouchesSelection(state, match, presentation)) {
      for (const token of mathTokens(presentation.source)) {
        for (const segment of presentation.segments) {
          const from = Math.max(token.from, segment.sourceFrom);
          const to = Math.min(token.to, segment.sourceFrom + segment.to - segment.from);
          if (to > from) ranges.push(Decoration.mark({ class: `lsd-token-${token.kind}` }).range(
            segment.from + from - segment.sourceFrom, segment.from + to - segment.sourceFrom
          ));
        }
      }
      for (const edge of [match.from, match.to - 2]) {
        ranges.push(Decoration.mark({ class: "lsd-token-delimiter" }).range(edge, edge + 2));
      }
      for (const selection of state.selection.ranges) {
        if (!selection.empty) continue;
        const braces = matchingBraces(match.source, selection.head - match.from - 2);
        for (const brace of braces) {
          const position = match.from + 2 + brace;
          ranges.push(Decoration.mark({ class: braces.length === 2 ? "lsd-brace-match" : "lsd-brace-unmatched" }).range(position, position + 1));
        }
      }
      ranges.push(
        Decoration.mark({ class: "lsd-math-source" }).range(
          match.from,
          match.to
        )
      );
      // Host Markdown can classify TeX rows as headings (notably a standalone
      // '=' after \end{...}). Reset typography only on complete source lines,
      // leaving Markdown before/after an inline or mixed-line equation alone.
      const firstLine = state.doc.lineAt(match.from);
      const lastLine = state.doc.lineAt(match.to);
      for (let number = firstLine.number; number <= lastLine.number; number++) {
        const line = state.doc.line(number);
        if (line.from >= match.from && line.to <= match.to) {
          ranges.push(Decoration.line({class: "lsd-math-source-line"}).range(line.from));
        }
      }
      // Keep literal source markers stable across the composition lifecycle.
      // Removing them exposes Obsidian's (possibly frozen) empty replacements
      // for Markdown escapes, so even an idle IME can hide the '\\' in '\\['.
      // CodeMirror preserves the text node owned by the IME and applies these
      // decorations outside it; do not remove all markers or patch contentDOM.
      for (const marker of markdownFormattingMarkersInMath(state, match)) {
        ranges.push(
          Decoration.replace({
            widget: new LiteralMarkerWidget(marker.text)
          }).range(marker.from, marker.to)
        );
      }
      continue;
    }

    const startLine = state.doc.lineAt(match.from);
    const endLine = state.doc.lineAt(match.to);
    const crossesLines = startLine.number !== endLine.number;
    const isWholeLineBlock =
      match.display && match.from === startLine.from && match.to === endLine.to;

    if (crossesLines && !isWholeLineBlock) {
      const contentRanges = containerReplacementRanges(documentText, match, presentation);
      for (let i = 0; i < contentRanges.length; i++) {
        const range = contentRanges[i];
        ranges.push(Decoration.replace({
          widget: i === 0 ? new MathWidget(presentation.source, true, false, presentation.standalone) : undefined
        }).range(range.from, range.to));
      }
      // Prefix-preserving replacements retain the host's list/callout grammar,
      // but their now-empty source rows must not retain editor line height.
      // Keep a closing row with following prose visible.
      if (contentRanges.length) {
        for (let number = startLine.number + 1; number <= endLine.number; number++) {
          const line = state.doc.line(number);
          if (number === endLine.number && line.text.slice(match.to - line.from).trim()) continue;
          ranges.push(Decoration.line({class: "lsd-math-hidden-line"}).range(line.from));
        }
      }
      continue;
    }

    ranges.push(
      Decoration.replace({
        widget: new MathWidget(
          presentation.source,
          match.display,
          isWholeLineBlock,
          presentation.standalone
        ),
        block: isWholeLineBlock
      }).range(match.from, match.to)
    );
  }
  const storedPreview = state.field(editingPreviewState, false);
  const preview = storedPreview === undefined ? (composing ? null : selectedEditingPreview(state)) : storedPreview;
  // A separate block after the source avoids placing uneditable rendered DOM
  // between source characters, including while selecting or composing text.
  if (preview) ranges.push(Decoration.widget({
    widget: new EditingPreviewWidget(preview.source, preview.display, preview.identity), block: true, side: 1
  }).range(preview.at));
  return Decoration.set(ranges, true);
}

const livePreviewExtension = StateField.define<DecorationSet>({
  create: buildLivePreviewDecorations,
  update(decorations, transaction) {
    const livePreviewChanged =
      transaction.startState.field(editorLivePreviewField, false) !==
      transaction.state.field(editorLivePreviewField, false);
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    if (transaction.startState.field(vimSourceState, false) !== transaction.state.field(vimSourceState, false) || transaction.startState.field(compositionState, false) !== transaction.state.field(compositionState, false) || transaction.startState.facet(renderOptions) !== transaction.state.facet(renderOptions) || transaction.docChanged || livePreviewChanged || selectionChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return buildLivePreviewDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => [Prec.highest(EditorView.decorations.from(field)), mathCaretMemory, mathPreviewFocus]
});

function enterMathVertically(view: EditorView, forward: boolean): boolean {
  const state = view.state;
  if (view.composing) return false;
  if (!state.facet(renderOptions).enabled || !state.field(editorLivePreviewField, false) || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const matches = parsedMatches(state);
  if (matches.some(match => rangeTouchesSelection(state, match))) return false;
  const head = state.selection.main.head;
  const target = view.moveVertically(state.selection.main, forward).head;
  const documentText = state.doc.toString();
  const candidates = matches.filter(match => match.display &&
    (mathPresentation(documentText, match).standalone ||
      (state.doc.lineAt(match.from).number !== state.doc.lineAt(match.to).number &&
        mathPresentation(documentText, match).projected)) &&
    // Vertical movement may land on preserved list indentation rather than
    // the delimiter itself. Treat the whole boundary row as the entry target.
    (forward ? match.from >= head && state.doc.lineAt(match.from).from <= target
      : match.to <= head && state.doc.lineAt(match.to).to >= target));
  const match = forward ? candidates[0] : candidates[candidates.length - 1];
  if (!match) return false;
  const anchor = forward ? match.from + 2 : match.to - 2;
  revealContainingCallout(view, anchor);
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  return true;
}

const mathNavigation = Prec.highest(keymap.of([
  { key: "ArrowDown", run: view => enterMathVertically(view, true) },
  { key: "ArrowUp", run: view => enterMathVertically(view, false) }
]));

const COLOR_KINDS = ["command", "brace", "number", "operator", "delimiter", "comment"] as const;
type Colors = Partial<Record<typeof COLOR_KINDS[number], string>>;

export default class LatexDelimiterRenderer extends Plugin {
  colors: Colors = {};
  editingPreviews = true;
  renderingMode: "automatic" | "off" = "automatic";
  private knownRendererConflict = false;
  private rendererEnabled = true;
  private disposed = false;
  private checkingConflict = false;
  private embeddedChildren = new Map<HTMLElement, EmbeddedMathRenderChild>();
  private pendingReadingRefresh = new Map<MarkdownView, { source: string; scroll?: number; pixels?: number; cancel: () => void }>();
  private fileReadVersions = new WeakMap<TFile, number>();
  private refreshedReadingSource = new WeakMap<MarkdownView, string>();
  private readingRemounts = new Map<MarkdownView, {
    context: MarkdownPostProcessorContext; component: Component; children: Set<MarkdownRenderChild>;
    dispose: () => void; schedule: () => void;
  }>();
  private diagnosticModals = new Set<EquationDiagnosticModal>();
  private extensions = [livePreviewExtension, EditorView.theme({}), mathNavigation, renderOptions.of({ previews: true, enabled: true }), compositionState, compositionEvents, vimSourceState, vimSourceObserver, calloutCaretObserver, embeddedWidgetObserver, refreshEmbedded.of(() => this.refreshEmbeddedMath()), editingPreviewState, displayLayout];

  async saveColors(): Promise<void> {
    await this.saveData({ colors: this.colors, editingPreviews: this.editingPreviews, renderingMode: this.renderingMode });
    await this.checkRendererConflict();
    this.applyColors();
    this.app.workspace.updateOptions();
  }

  private applyColors(): void {
    const variables: Record<string, string> = {};
    for (const kind of COLOR_KINDS) {
      const value = this.colors[kind];
      if (value && /^#[0-9a-f]{6}$/i.test(value)) variables[`--lsd-${kind}`] = value;
    }
    this.extensions[1] = EditorView.theme({ "&": variables });
    this.extensions[3] = renderOptions.of({ previews: this.editingPreviews, enabled: this.rendererEnabled });
  }

  async onload(): Promise<void> {
    const saved = await this.loadData() as { colors?: Colors; editingPreviews?: boolean; renderingMode?: string } | null;
    this.colors = saved?.colors && typeof saved.colors === "object" ? saved.colors : {};
    this.editingPreviews = saved?.editingPreviews !== false;
    this.renderingMode = saved?.renderingMode === "off" ? "off" : "automatic";
    await this.checkRendererConflict();
    this.applyColors();
    this.addSettingTab(new MathColorsTab(this));
    await loadMathJax();
    this.addCommand({
      id: "diagnose-selected-equation", name: "Diagnose selected equation",
      editorCallback: (editor, view) => this.openEquationDiagnostic(editor, view, false)
    });
    this.addCommand({
      id: "preview-equation-repair", name: "Preview equation repair",
      editorCallback: (editor, view) => this.openEquationDiagnostic(editor, view, true)
    });

    this.registerMarkdownPostProcessor((element, context) => {
      if (this.rendererEnabled) {
        return renderReadingView(element, context, this);
      }
    });
    this.registerEditorExtension(this.extensions);
    this.registerInterval(window.setInterval(() => { void this.checkRendererConflict(); }, 2000));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.refreshEmbeddedMath();
      this.pruneReadingRefreshes();
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      if (info.file) {
        this.fileReadVersions.set(info.file, (this.fileReadVersions.get(info.file) ?? 0) + 1);
        this.refreshChangedCrossSection(info.file.path, editor.getValue());
      }
    }));
    this.registerEvent(this.app.vault.on("modify", file => {
      if (!(file instanceof TFile) || file.extension !== "md" || !this.hasReadingPane(file.path)) return;
      const revision = (this.fileReadVersions.get(file) ?? 0) + 1;
      this.fileReadVersions.set(file, revision);
      void this.app.vault.cachedRead(file).then(text => {
        if (this.fileReadVersions.get(file) === revision) this.refreshChangedCrossSection(file.path, text);
      }).catch(() => { /* A file may disappear while a queued read is pending. */ });
    }));

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.updateOptions();
      this.refreshEmbeddedMath();
    });
  }

  private openEquationDiagnostic(editor: Editor, context: MarkdownView | import("obsidian").MarkdownFileInfo, repair: boolean): void {
    if (!(context instanceof MarkdownView)) { new Notice("Open the equation in a Markdown editor first."); return; }
    if (editor.listSelections().length !== 1) { new Notice("Select one equation block to diagnose."); return; }
    const snapshot = editor.getValue();
    const diagnosis = diagnoseEquation(snapshot, editor.posToOffset(editor.getCursor("from")), editor.posToOffset(editor.getCursor("to")));
    const modal = new EquationDiagnosticModal(this.app, diagnosis, editor, context, snapshot, context.file?.path, this.renderingStatus, repair, () => this.diagnosticModals.delete(modal));
    this.diagnosticModals.add(modal);
    modal.open();
  }

  // The native virtualizer can remount a processed paragraph after unloading
  // its render children. A view-owned coordinator reclaims source-bound math in
  // those remounted sections; its lifetime is independent of paragraph caching.
  watchReadingRemounts(element: HTMLElement, context: MarkdownPostProcessorContext): void {
    if (managedReadingContexts.has(context) || this.disposed || !this.rendererEnabled) return;
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.getMode() !== "preview" || !view.previewMode.containerEl.contains(element)) return;
      const existing = this.readingRemounts.get(view);
      if (existing) { existing.context = context; return; }
      const component = this.addChild(new Component()), children = new Set<MarkdownRenderChild>();
      const timerWindow = element.ownerDocument.defaultView ?? window;
      let frame = 0, busy = false, dirty = false, active = true;
      const schedule = (): void => {
        if (!active || this.disposed || !this.rendererEnabled) return;
        if (busy) { dirty = true; return; }
        if (!frame) frame = timerWindow.requestAnimationFrame(() => { frame = 0; void process(); });
      };
      const observer = new timerWindow.MutationObserver(records => {
        if (records.some(record => {
          const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
          return target && !target.closest(".lsd-math, mjx-container, .math, .mod-ui");
        })) schedule();
      });
      const record = { context, component, children, schedule, dispose: (): void => {
        active = false; timerWindow.cancelAnimationFrame(frame); observer.disconnect(); this.removeChild(component);
      } };
      const process = async (): Promise<void> => {
        if (!active || this.disposed || !this.rendererEnabled || !view.containerEl.isConnected || view.getMode() !== "preview" || view.file?.path !== record.context.sourcePath) return;
        busy = true;
        try {
          for (const child of children) if (!view.previewMode.containerEl.contains(child.containerEl)) {
            component.removeChild(child); children.delete(child);
          }
          const source = view.previewMode.get(), base = record.context, parent = view.previewMode.containerEl.querySelector<HTMLElement>(".markdown-preview-section");
          if (!parent) return;
          const starts = [0];
          for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
          const matches = readingMatches(source);
          const managed: MarkdownPostProcessorContext = {
            docId: base.docId, sourcePath: base.sourcePath, frontmatter: base.frontmatter as unknown,
            addChild: child => { children.add(child); component.addChild(child); },
            getSectionInfo: node => active && view.previewMode.containerEl.contains(node) && view.previewMode.get() === source ? base.getSectionInfo(node) : null
          };
          managedReadingContexts.add(managed);
          for (const part of Array.from(parent.children) as HTMLElement[]) {
            if (part.classList.contains("mod-ui") || !part.textContent) continue;
            const info = managed.getSectionInfo(part);
            if (!info || info.text !== source) continue;
            const from = starts[info.lineStart] ?? 0, to = starts[info.lineEnd + 1] ?? source.length;
            const relevant = matches.filter(match => match.from >= from && match.from < to);
            if (!relevant.length) continue;
            const owned = new Set(elementScopes.get(part)?.replacements.filter(replacement =>
              replacement.element.classList.contains("lsd-math") && part.contains(replacement.element)).map(replacement => replacement.key));
            if (relevant.every(match => owned.has(`${match.from}:${match.to}`))) continue;
            await renderReadingView(part, managed, this);
          }
        } catch (error) { console.error("Standard delimiters remount rendering:", error); }
        finally { busy = false; if (dirty) { dirty = false; schedule(); } }
      };
      this.readingRemounts.set(view, record);
      observer.observe(view.previewMode.containerEl, { childList: true, subtree: true });
    });
  }

  private pruneReadingRefreshes(): void {
    if (this.pendingReadingRefresh.size === 0 && this.readingRemounts.size === 0) return;
    const open = new Set<MarkdownView>();
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof MarkdownView) open.add(leaf.view); });
    for (const [view, record] of this.readingRemounts) {
      if (!open.has(view) || !view.containerEl.isConnected || view.getMode() !== "preview" || view.file?.path !== record.context.sourcePath) {
        record.dispose(); this.readingRemounts.delete(view);
      }
    }
    for (const [view, pending] of this.pendingReadingRefresh) {
      if (!open.has(view) || !view.containerEl.isConnected || view.getMode() !== "preview") {
        pending.cancel(); this.pendingReadingRefresh.delete(view);
      }
    }
  }

  private hasReadingPane(sourcePath: string): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === sourcePath && leaf.view.getMode() === "preview") found = true;
    });
    return found;
  }

  // Restore cross-section DOM before the host rebuilds individual paragraphs.
  // After its update, rebuild the affected preview from the newest revision.
  // Ordinary notes keep Obsidian's normal incremental rendering path.
  private refreshChangedCrossSection(sourcePath: string, text: string): void {
    if (this.disposed || !this.rendererEnabled || !this.hasReadingPane(sourcePath)) return;
    const hasCrossSectionMath = readingMatches(text).some(match => match.display &&
      /\n[ \t]*\n/.test(mathPresentation(text, match).source));
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== sourcePath || view.getMode() !== "preview") return;
      const previous = this.pendingReadingRefresh.get(view);
      if (previous?.source === text || (!previous && this.refreshedReadingSource.get(view) === text && view.previewMode.get() === text)) return;
      // On 1.13.7 the scrolling preview can be inside the public container.
      const scroller = (): HTMLElement => view.previewMode.containerEl.querySelector<HTMLElement>(".markdown-preview-view") ?? view.previewMode.containerEl;
      const currentScroll = view.previewMode.getScroll();
      const retainedScroll = previous?.scroll ?? (Number.isFinite(currentScroll) ? currentScroll : 0);
      const retainedPixels = previous?.pixels ?? scroller().scrollTop;
      const scopes = [...(renderScopes.get(this) ?? [])].filter(scope => view.previewMode.containerEl.contains(scope.containerEl));
      if (!hasCrossSectionMath && !scopes.some(scope => scope.crossSection) && !this.pendingReadingRefresh.has(view)) return;
      for (const scope of scopes) scope.unload();
      previous?.cancel();
      const timerWindow = view.containerEl.ownerDocument.defaultView ?? window;
      let timer = 0, frame = 0, attempts = 0;
      const pending: { source: string; scroll?: number; pixels?: number; cancel: () => void } = {
        source: text, scroll: retainedScroll, pixels: retainedPixels,
        cancel: () => { timerWindow.clearTimeout(timer); timerWindow.cancelAnimationFrame(frame); }
      };
      const isCurrent = (): boolean => !this.disposed && this.rendererEnabled && leaf.view === view &&
        view.containerEl.isConnected && view.file?.path === sourcePath && view.getMode() === "preview" &&
        this.pendingReadingRefresh.get(view) === pending;
      const finish = (): void => { if (this.pendingReadingRefresh.get(view) === pending) this.pendingReadingRefresh.delete(view); };
      const refresh = (): void => {
        if (!isCurrent()) { finish(); return; }
        if (view.previewMode.get() !== text) {
          if (++attempts < 20) timer = timerWindow.setTimeout(refresh, 100);
          else finish();
          return;
        }
        const scroll = pending.scroll ?? view.previewMode.getScroll();
        pending.scroll = scroll;
        for (const scope of renderScopes.get(this) ?? []) if (view.previewMode.containerEl.contains(scope.containerEl)) scope.unload();
        // A rerender can retain cached, already-processed paragraphs on large
        // notes. Rebuild this renderer's data so all mounted sections receive
        // new processor ownership, then retain the user's logical scroll anchor.
        view.previewMode.clear();
        view.previewMode.set(text, true);
        this.refreshedReadingSource.set(view, text);
        // Native line mapping may be NaN until virtualized sections finish
        // layout. Keep the pixel anchor meanwhile; apply the logical anchor only
        // when it is usable. Every frame remains owned by this source revision.
        let scrollFrames = 0;
        const restoreScroll = (): void => {
          if (!isCurrent() || view.previewMode.get() !== text) { finish(); return; }
          if (Number.isFinite(view.previewMode.getScroll())) {
            view.previewMode.applyScroll(scroll);
            if (Math.abs(view.previewMode.getScroll() - scroll) < 0.5) { finish(); return; }
          }
          scroller().scrollTop = pending.pixels ?? 0;
          if (++scrollFrames < 60) frame = timerWindow.requestAnimationFrame(restoreScroll);
          else finish();
        };
        frame = timerWindow.requestAnimationFrame(restoreScroll);
      };
      timer = timerWindow.setTimeout(refresh, 100);
      this.pendingReadingRefresh.set(view, pending);
    });
  }

  private async checkRendererConflict(): Promise<void> {
    if (this.checkingConflict || this.disposed) return;
    this.checkingConflict = true;
    try {
      const configPath = `${this.app.vault.configDir}/community-plugins.json`;
      const value: unknown = await this.app.vault.adapter.exists(configPath)
        ? JSON.parse(await this.app.vault.adapter.read(configPath)) : [];
      if (!Array.isArray(value) || this.disposed) return;
      this.knownRendererConflict = value.includes("latex-delimiter-renderer") || value.includes("latex-standard-delimiters");
      const enabled = this.renderingMode === "automatic" && !this.knownRendererConflict;
      if (enabled === this.rendererEnabled) return;
      this.rendererEnabled = enabled;
      if (enabled) disabledRenderers.delete(this); else disabledRenderers.add(this);
      for (const scope of renderScopes.get(this) ?? []) {
        if (!enabled) scope.restore();
        else void renderReadingView(scope.containerEl, scope.context, this);
      }
      if (!enabled && this.renderingMode === "automatic") new Notice("Another delimiter renderer is enabled. Standard delimiter rendering is paused here to prevent duplicate equations. Disable the other delimiter renderer to resume automatically. You can inspect rendering status in this plugin’s settings.", 10000);
      this.applyColors();
      this.app.workspace.updateOptions();
      this.app.workspace.iterateAllLeaves(leaf => {
        if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
      });
    } catch {
      // Hidden configuration may be temporarily unavailable during syncing.
      // Keep the last known state and retry without breaking the editor.
    } finally { this.checkingConflict = false; }
  }

  get renderingStatus(): string {
    if (this.renderingMode === "off") return "Rendering is off by your choice. Other plugins can handle equations.";
    if (this.knownRendererConflict) return "Paused: another standard delimiter renderer is enabled. Disable LaTeX Delimiter Renderer and LaTeX Standard Delimiters to let Plus handle equations.";
    return "Active: this plugin handles standard delimiters. MathJax extensions continue to use the shared engine.";
  }

  async refreshRenderingStatus(): Promise<void> { await this.checkRendererConflict(); }

  private refreshEmbeddedMath(): void {
    for (const [element, child] of this.embeddedChildren) {
      if (!element.isConnected) { this.removeChild(child); this.embeddedChildren.delete(element); }
    }
    if (!this.rendererEnabled || this.disposed) return;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) return;
      const sourcePath = leaf.view.file.path;
      for (const element of Array.from(leaf.view.containerEl.querySelectorAll<HTMLElement>(".cm-table-widget td, .cm-table-widget th, .cm-callout .callout-title-inner, .cm-callout .callout-content"))) {
        if (this.embeddedChildren.has(element) || embeddedElements.has(element) || element.querySelector(".lsd-math")) continue;
        const context: MarkdownPostProcessorContext = {
          docId: sourcePath, sourcePath, frontmatter: null,
          addChild: child => { this.addChild(child); }, getSectionInfo: () => null
        };
        const child = new EmbeddedMathRenderChild(element, context, this);
        this.embeddedChildren.set(element, child); this.addChild(child);
      }
    });
  }

  onunload(): void {
    this.disposed = true; disabledRenderers.add(this);
    for (const modal of this.diagnosticModals) modal.close();
    this.diagnosticModals.clear();
    for (const record of this.readingRemounts.values()) record.dispose();
    this.readingRemounts.clear();
    for (const scope of renderScopes.get(this) ?? []) scope.unload();
    renderScopes.get(this)?.clear();
    for (const child of crossSectionChildren.get(this) ?? []) child.unload();
    crossSectionChildren.get(this)?.clear();
    for (const pending of this.pendingReadingRefresh.values()) pending.cancel();
    this.pendingReadingRefresh.clear();
    this.embeddedChildren.clear(); readingParseCache.clear();
  }

}

// Declarative definitions participate in Obsidian's global settings search.
class MathColorsTab extends PluginSettingTab {
  constructor(private readonly plugin: LatexDelimiterRenderer) { super(plugin.app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Standard delimiter rendering",
        desc: "Automatic pauses for the known competing renderer. Off leaves rendering to other tools. This never changes another plugin’s settings.",
        aliases: ["LaTeX", "MathJax", "equations"],
        control: { type: "dropdown", key: "renderingMode", options: { automatic: "Automatic", off: "Off" } }
      },
      {
        name: "Rendering status", desc: this.plugin.renderingStatus,
        render: setting => { setting.addButton(button => {
          button.setButtonText("Refresh").onClick(async () => { await this.plugin.refreshRenderingStatus(); this.update(); });
        }); }
      },
      {
        name: "Preview equations while editing",
        desc: "Keep a preview beneath the equation while editing or selecting its source. During input-method composition, keep the last preview until the text is committed. Multiple cursors and selections spanning surrounding text do not show previews.",
        aliases: ["LaTeX", "live preview"],
        control: { type: "toggle", key: "editingPreviews" }
      },
      ...COLOR_KINDS.map(kind => ({
        name: `${kind[0].toUpperCase()}${kind.slice(1)} color`,
        desc: "Leave empty to follow your theme, or enter a six-digit hex color, for example #88aaff.",
        aliases: ["math", "LaTeX", "syntax coloring"],
        control: {
          type: "text" as const, key: kind, placeholder: "Theme default",
          validate: (value: string) => value === "" || /^#[0-9a-f]{6}$/i.test(value) ? undefined : "Enter a six-digit hex color, for example #88aaff, or leave empty."
        }
      }))
    ];
  }

  getControlValue(key: string): unknown {
    if (key === "renderingMode") return this.plugin.renderingMode;
    if (key === "editingPreviews") return this.plugin.editingPreviews;
    const kind = COLOR_KINDS.find(kind => kind === key);
    return kind ? this.plugin.colors[kind] ?? "" : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "renderingMode") {
      if (value !== "off" && value !== "automatic") return;
      this.plugin.renderingMode = value;
    } else if (key === "editingPreviews") {
      if (typeof value !== "boolean") return;
      this.plugin.editingPreviews = value;
    } else {
      const kind = COLOR_KINDS.find(kind => kind === key);
      if (!kind || typeof value !== "string" || (value !== "" && !/^#[0-9a-f]{6}$/i.test(value))) return;
      this.plugin.colors[kind] = value;
    }
    await this.plugin.saveColors();
    if (key === "renderingMode") this.update();
  }
}
