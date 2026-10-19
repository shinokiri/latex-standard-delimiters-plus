import {existsSync, readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const bundlePath = new URL('../../.local-fixtures/obsidian-mathjax.js', import.meta.url);
export const hasNativeMathJax = existsSync(bundlePath);

/** The optional runtime is extracted from the installed APK, never shipped.
 * This validates actual CHTML/TeX, not browser geometry or keyboard behavior.
 */
export async function nativeMathJax() {
  const dom = new JSDOM('<!doctype html><body></body>', {runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://fixture.invalid/'});
  const win = dom.window;
  win.fetch = () => Promise.reject(new Error('No network in MathJax fixture'));
  // Construct the configuration in the browser realm: MathJax checks Object's
  // constructor and ignores objects imported directly from the Node realm.
  win.eval('window.MathJax = ' + JSON.stringify({
    loader: {paths: {'mathjax-tex': '/lib/mathjax/tex-font', 'mathjax-mhchem-extension': '/lib/mathjax/mhchem-font-extension'}},
    output: {font: 'mathjax-tex', fontExtensions: ['mathjax-mhchem']},
    tex: {packages: {'[+]': ['action', 'amscd', 'bbox', 'boldsymbol', 'braket', 'bussproofs', 'cancel', 'cases', 'centernot', 'color', 'colortbl', 'empheq', 'enclose', 'extpfeil', 'gensymb', 'html', 'mathtools', 'mhchem', 'noerrors', 'tagformat', 'textcomp', 'unicode', 'upgreek', 'verb']}},
    startup: {typeset: false}, options: {enableMenu: false, enableEnrichment: false, enableExplorer: false},
  }));
  win.eval(readFileSync(bundlePath, 'utf8'));
  const math = win.MathJax as {version: string; startup: {promise: Promise<void>; document: {options: Record<string, unknown>}}; tex2chtml(source: string, options: {display: boolean}): HTMLElement};
  await math.startup.promise;
  // The host also reapplies these after startup, which reads menu defaults.
  Object.assign(math.startup.document.options, {enableMenu: false, enableEnrichment: false, enableExplorer: false, enableSpeech: false, enableBraille: false});
  return {version: math.version, render: (source: string) => math.tex2chtml(source, {display: true}), close: () => dom.window.close()};
}
