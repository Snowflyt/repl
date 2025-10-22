import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/github-dark.css";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);

export function highlightCode(code: string, language = "typescript"): string {
  return hljs.highlight(code, { language }).value;
}

/**
 * Create a Marked instance configured with highlight.js for JSDoc/Markdown rendering.
 *
 * @returns A configured Marked instance with highlight.js integration.
 */
export function createMarkedRenderer(): Marked {
  return new Marked(
    markedHighlight({
      emptyLangClass: "hljs",
      langPrefix: "hljs language-",
      highlight(code, lang) {
        const l = (lang || "").toLowerCase();
        let mapped = "plaintext";
        if (l === "ts" || l === "tsx" || l === "mts" || l === "cts" || l === "typescript")
          mapped = "typescript";
        else if (l === "js" || l === "jsx" || l === "mjs" || l === "cjs" || l === "javascript")
          mapped = "javascript";
        else if (hljs.getLanguage(l)) mapped = l;
        if (!["javascript", "typescript"].includes(mapped)) return code;
        return hljs.highlight(code, { language: mapped }).value;
      },
    }),
  );
}
