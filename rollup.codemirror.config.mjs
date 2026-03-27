import {nodeResolve} from "@rollup/plugin-node-resolve";

export default {
  input: "ui/vendor/codemirror/file-editor.js",
  output: {
    file: "ui/vendor/codemirror/file-editor.bundle.js",
    format: "iife",
    name: "AIExeCodeMirrorBundle",
    sourcemap: false,
  },
  plugins: [
    nodeResolve({
      browser: true,
    }),
  ],
};
