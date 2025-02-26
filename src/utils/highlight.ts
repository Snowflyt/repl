import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("typescript", typescript);

export const highlightCode = (code: string) =>
  hljs.highlight(code, { language: "typescript" }).value;
