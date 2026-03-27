import {EditorState, Compartment} from "@codemirror/state";
import {EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, highlightActiveLine} from "@codemirror/view";
import {defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands";
import {searchKeymap, highlightSelectionMatches} from "@codemirror/search";
import {defaultHighlightStyle, syntaxHighlighting} from "@codemirror/language";
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

function createTheme() {
  return EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "#0a0b0e",
      color: "#e2e8f0",
      fontFamily: '"SFMono-Regular", "Consolas", "Menlo", "Liberation Mono", monospace',
      fontSize: "13px"
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "20.8px"
    },
    ".cm-content, .cm-gutter": {
      minHeight: "100%"
    },
    ".cm-content": {
      caretColor: "#e2e8f0"
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#e2e8f0"
    },
    ".cm-gutters": {
      backgroundColor: "rgba(10, 12, 18, 0.82)",
      color: "rgba(148, 163, 184, 0.72)",
      borderRight: "1px solid rgba(37, 43, 61, 0.75)"
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(92, 129, 196, 0.16)"
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(92, 129, 196, 0.14)",
      color: "rgba(235, 244, 255, 0.98)"
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(82, 174, 255, 0.24)"
    },
    ".cm-panels": {
      backgroundColor: "#0f1117",
      color: "#e2e8f0",
      borderBottom: "1px solid #1e2333"
    },
    ".cm-search .cm-textfield": {
      backgroundColor: "rgba(10, 15, 28, 0.72)",
      color: "#e2e8f0",
      border: "1px solid rgba(52, 60, 84, 0.95)",
      borderRadius: "7px"
    },
    ".cm-search .cm-button": {
      background: "transparent",
      color: "rgba(226, 232, 240, 0.82)",
      border: "1px solid rgba(52, 60, 84, 0.95)",
      borderRadius: "7px"
    },
    ".cm-search .cm-button:hover": {
      background: "rgba(255,255,255,0.06)",
      color: "#fff"
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(255, 214, 10, 0.28)",
      outline: "1px solid rgba(255, 214, 10, 0.35)"
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(255, 214, 10, 0.45)"
    }
  }, {dark: true});
}

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
        syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
        languageCompartment.of(languageExtension(options.language)),
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
        changes: {from: 0, to: view.state.doc.length, insert: next}
      });
      suppress = false;
    },
    setLanguage(lang) {
      view.dispatch({
        effects: languageCompartment.reconfigure(languageExtension(lang))
      });
    },
  };
}

if (typeof window !== "undefined") {
  window.AIExeCodeMirror = { createFileEditor };
}
