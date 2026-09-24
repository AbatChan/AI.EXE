import {EditorState, Compartment, StateField, StateEffect, RangeSetBuilder} from "@codemirror/state";
import {EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, highlightActiveLine, Decoration} from "@codemirror/view";
import {defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands";
import {searchKeymap, highlightSelectionMatches} from "@codemirror/search";
import {HighlightStyle, syntaxHighlighting} from "@codemirror/language";
import {tags as t} from "@lezer/highlight";
import {javascript} from "@codemirror/lang-javascript";
import {python} from "@codemirror/lang-python";
import {json} from "@codemirror/lang-json";
import {html} from "@codemirror/lang-html";
import {css} from "@codemirror/lang-css";
import {markdown} from "@codemirror/lang-markdown";
import {yaml} from "@codemirror/lang-yaml";
import {xml} from "@codemirror/lang-xml";
import {java} from "@codemirror/lang-java";
import {rust} from "@codemirror/lang-rust";
import {sql} from "@codemirror/lang-sql";

function languageExtension(lang) {
  switch (String(lang || "").toLowerCase()) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":
      return javascript({jsx: true, typescript: /^(typescript|tsx)$/.test(String(lang || "").toLowerCase())});
    case "python":
      return python();
    case "json":
      return json();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "markdown":
      return markdown();
    case "yaml":
      return yaml();
    case "xml":
      return xml();
    case "java":
      return java();
    case "rust":
      return rust();
    case "sql":
      return sql();
    default:
      return [];
  }
}

// App tokens (ai-exe.css) drive every color, so the editor follows light/dark live.
function createTheme() {
  return EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--bg)",
      color: "var(--text)",
      fontFamily: '"SFMono-Regular", "Consolas", "Menlo", "Liberation Mono", monospace',
      fontSize: "13px"
    },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "21px" },
    ".cm-content, .cm-gutter": { minHeight: "100%" },
    ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--text4)", border: "none", paddingLeft: "6px" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 8px" },
    ".cm-activeLine": { backgroundColor: "var(--ink-04)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text2)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-24)" },
    ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)", borderBottom: "1px solid var(--ui-line)" },
    ".cm-search .cm-textfield": { backgroundColor: "var(--ui-surface)", color: "var(--text)", border: "1px solid var(--ui-line)", borderRadius: "7px" },
    ".cm-search .cm-button": { background: "transparent", color: "var(--text2)", border: "1px solid var(--ui-line)", borderRadius: "7px" },
    ".cm-search .cm-button:hover": { background: "var(--ink-06)", color: "var(--text)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 22%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 45%, transparent)" },
    ".cm-selectionMatch": { backgroundColor: "var(--ink-08)" },
    // Range highlight for "go to the read/edited region" from the agent work panel.
    ".cm-range-hl-read": { backgroundColor: "color-mix(in srgb, var(--link) 14%, transparent)" },
    ".cm-range-hl-edit": { backgroundColor: "color-mix(in srgb, var(--good) 14%, transparent)" }
  });
}

// Syntax colors from the same semantic tokens.
const appHighlightStyle = HighlightStyle.define([
  {tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword], color: "var(--violet)"},
  {tag: [t.string, t.special(t.string), t.regexp], color: "var(--good)"},
  {tag: [t.number, t.bool, t.null, t.atom], color: "var(--warn)"},
  {tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: "var(--text4)", fontStyle: "italic"},
  {tag: [t.tagName, t.angleBracket], color: "var(--bad)"},
  {tag: [t.attributeName, t.propertyName], color: "var(--link)"},
  {tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--accent)"},
  {tag: [t.typeName, t.className, t.namespace], color: "var(--warn)"},
  {tag: [t.heading], color: "var(--text)", fontWeight: "600"},
  {tag: [t.link, t.url], color: "var(--link)", textDecoration: "underline"},
  {tag: [t.emphasis], fontStyle: "italic"},
  {tag: [t.strong], fontWeight: "600"},
  {tag: [t.invalid], color: "var(--bad)"},
]);

// Effect + field that paint a contiguous line range (read = blue, edit = green).
const setRangeHighlight = StateEffect.define();
const rangeHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setRangeHighlight)) continue;
      if (!e.value) return Decoration.none;
      const doc = tr.state.doc;
      const total = doc.lines;
      const start = Math.max(1, Math.min(total, Math.floor(Number(e.value.startLine) || 1)));
      const end = Math.max(start, Math.min(total, Math.floor(Number(e.value.endLine) || start)));
      const cls = `cm-range-hl-${e.value.kind === "edit" ? "edit" : "read"}`;
      const lineDeco = Decoration.line({class: cls});
      const builder = new RangeSetBuilder();
      for (let ln = start; ln <= end; ln += 1) {
        const line = doc.line(ln);
        builder.add(line.from, line.from, lineDeco);
      }
      return builder.finish();
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function createFileEditor(host, options = {}) {
  const languageCompartment = new Compartment();
  let suppress = false;
  const theme = createTheme();
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: String(options.value || ""),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        drawSelection(),
        highlightActiveLine(),
        history(),
        keymap.of([
          {key: "Mod-s", preventDefault: true, run: () => {
            if (typeof options.onSave === "function") options.onSave();
            return true;
          }},
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        highlightSelectionMatches(),
        syntaxHighlighting(appHighlightStyle),
        languageCompartment.of(languageExtension(options.language)),
        rangeHighlightField,
        theme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || suppress) return;
          if (typeof options.onChange === "function") {
            options.onChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });

  return {
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
    getValue() {
      return view.state.doc.toString();
    },
    setValue(value) {
      const next = String(value || "");
      if (next === view.state.doc.toString()) return;
      suppress = true;
      view.dispatch({
        changes: {from: 0, to: view.state.doc.length, insert: next},
        effects: setRangeHighlight.of(null), // new content -> drop any stale highlight
      });
      suppress = false;
    },
    setLanguage(lang) {
      view.dispatch({
        effects: languageCompartment.reconfigure(languageExtension(lang))
      });
    },
    highlightRange(startLine, endLine, kind) {
      const total = view.state.doc.lines;
      const start = Math.max(1, Math.min(total, Math.floor(Number(startLine) || 1)));
      const end = Math.max(start, Math.min(total, Math.floor(Number(endLine) || start)));
      const line = view.state.doc.line(start);
      view.dispatch({
        selection: {anchor: line.from},
        effects: [
          setRangeHighlight.of({startLine: start, endLine: end, kind}),
          EditorView.scrollIntoView(line.from, {y: "center"}),
        ],
      });
      view.focus();
    },
    clearHighlight() {
      view.dispatch({effects: setRangeHighlight.of(null)});
    },
  };
}

if (typeof window !== "undefined") {
  window.AIExeCodeMirror = { createFileEditor };
}
