import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import type { CSSProperties } from "react";
import { forwardRef } from "react";

import { highlightCode } from "../utils/highlight";

export interface CompletionDetailPaneProps {
  detail: { detail?: string; documentation?: string } | null;
  docHtml?: string;
  loading: boolean;
  style?: CSSProperties;
  // Optional structured signature parts to allow UI-level highlighting of active parameter
  sigParts?: {
    prefix: string;
    separator: string;
    suffix: string;
    params: string[];
    activeIndex?: number;
  } | null;
}

const CompletionDetailPane = forwardRef<HTMLDivElement, CompletionDetailPaneProps>(
  function CompletionDetailPane({ detail, docHtml, loading, sigParts, style }, ref) {
    return (
      <div
        ref={ref}
        className="fixed z-40 w-160 max-w-[calc(100vw-16px)] rounded-md border border-gray-700/60 bg-[#1a1520]/80 py-3 pr-1 pl-3 text-sm text-gray-200 shadow-xl backdrop-blur-sm"
        style={style}>
        {loading ?
          <div className="flex items-center gap-2 text-gray-400">
            <Icon icon="svg-spinners:3-dots-fade" className="h-4 w-4" />
            <span>Loading details…</span>
          </div>
        : detail && (detail.detail || detail.documentation) ?
          <div className="repl-scroll max-h-[50vh] overflow-auto text-gray-200">
            {/* Scoped override to remove hljs background across the detail area */}
            <style>
              {'[data-docs="1"] .hljs,\n' +
                '[data-docs="1"] pre,\n' +
                '[data-docs="1"] pre code,\n' +
                '[data-docs="1"] code.hljs {\n' +
                "  background: transparent !important;\n" +
                "  background-color: transparent !important;\n" +
                "}\n" +
                // Restore list markers inside docs (Tailwind preflight removes them)
                '[data-docs="1"] ul {\n' +
                "  list-style: disc;\n" +
                "  padding-left: 1.25rem;\n" +
                "}\n" +
                '[data-docs="1"] ol {\n' +
                "  list-style: decimal;\n" +
                "  padding-left: 1.25rem;\n" +
                "}\n"}
            </style>
            <div data-docs="1">
              {((sigParts && sigParts.params.length > 0) || detail.detail) && (
                <div
                  className="mb-2 font-mono text-xs wrap-break-word text-gray-300"
                  title={detail.detail || undefined}>
                  {sigParts && (
                    <>
                      {/* Prefix */}
                      {sigParts.prefix && (
                        <span
                          className="hljs language-typescript"
                          dangerouslySetInnerHTML={{ __html: highlightCode(sigParts.prefix) }}
                        />
                      )}
                      {/* Params with separators */}
                      {sigParts.params.map((p, i) => (
                        <span key={i} className="inline">
                          {/* Highlight ONLY the parameter text */}
                          <span
                            className={clsx(
                              i === sigParts.activeIndex &&
                                "rounded-sm bg-amber-500/10 text-amber-200",
                            )}>
                            <span
                              className="hljs language-typescript"
                              dangerouslySetInnerHTML={{ __html: highlightCode(p) }}
                            />
                          </span>
                          {/* Render the separator outside the highlighted param */}
                          {i < sigParts.params.length - 1 && sigParts.separator && (
                            <span
                              className="hljs language-typescript"
                              dangerouslySetInnerHTML={{
                                __html: highlightCode(sigParts.separator),
                              }}
                            />
                          )}
                        </span>
                      ))}
                      {/* Suffix */}
                      {sigParts.suffix && (
                        <span
                          className="hljs language-typescript"
                          dangerouslySetInnerHTML={{ __html: highlightCode(sigParts.suffix) }}
                        />
                      )}
                    </>
                  )}
                  {!sigParts && detail.detail && (
                    <span
                      className="hljs language-typescript"
                      dangerouslySetInnerHTML={{ __html: highlightCode(detail.detail) }}
                    />
                  )}
                </div>
              )}
              {detail.documentation && (
                <div
                  className="leading-6"
                  // Render pre-parsed JSDoc HTML if available
                  dangerouslySetInnerHTML={{ __html: docHtml ?? "" }}
                />
              )}
            </div>
          </div>
        : <div className="text-gray-400">No details available</div>}
      </div>
    );
  },
);

export default CompletionDetailPane;
