import * as obsidian from "obsidian";
import { language, StreamLanguage } from "@codemirror/language";
import { Compartment, Prec } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { withStandardDelimiters, type NativeMode } from "./native-mode";
import { projectForNativeParser, type LegacyCodeMirror, type Projection } from "./projection";
import { installReadingAliases } from "./reading";

export default class NativeLatexDelimiters extends obsidian.Plugin {
  onload(): void {
    const cm = (window as unknown as { CodeMirror?: LegacyCodeMirror }).CodeMirror;
    const preview = (obsidian as unknown as { MarkdownPreviewRenderer?: { prototype: Record<string, unknown> } }).MarkdownPreviewRenderer;
    if (!cm?.getMode || !cm.StringStream || !preview) {
      new obsidian.Notice("Native LaTeX Delimiters: this Obsidian parser is not supported. No editor changes were installed.");
      return;
    }
    // Reading parsing may be asynchronous. Cache only a bounded number of exact
    // source revisions; a parse facade keeps its own in-flight projection.
    const cache = new Map<string, Projection>();
    const project = (source: string): Projection => {
      const existing = cache.get(source);
      if (existing) return existing;
      const result = projectForNativeParser(source, cm);
      if (source.length <= 2_000_000) {
        while (cache.size >= 2) cache.delete(cache.keys().next().value!);
        cache.set(source, result);
      }
      return result;
    };
    const disposeReading = installReadingAliases(preview.prototype, obsidian.MarkdownRenderer as unknown as Record<string, unknown>, project);
    this.register(() => { disposeReading(); cache.clear(); });

    const compartment = new Compartment();
    const extension = ViewPlugin.fromClass(class {
      private destroyed = false;
      constructor(view: EditorView) {
        const base = view.state.facet(language);
        const parser = (base as unknown as {streamParser?: NativeMode} | null)?.streamParser;
        // Use this editor's own mode, including the restricted table-cell mode.
        if (base?.name !== "hypermd" || !parser?.token || !parser.copyState || !parser.startState) return;
        const adapted = StreamLanguage.define(withStandardDelimiters(parser));
        queueMicrotask(() => {
          if (!this.destroyed && compartment.get(view.state) !== undefined && view.state.facet(language) === base) {
            view.dispatch({ effects: compartment.reconfigure(Prec.highest(adapted)) });
          }
        });
      }
      destroy(): void { this.destroyed = true; }
    });
    this.registerEditorExtension([compartment.of([]), extension]);
    const refresh = () => this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof obsidian.MarkdownView) leaf.view.previewMode.rerender(true);
    });
    this.app.workspace.onLayoutReady(refresh);
    this.register(refresh);
  }
}
