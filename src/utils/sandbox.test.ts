import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sandbox } from "./sandbox";

// ---------------------------------------------------------------------------
// We spy on the Function constructor to capture the transpiled code that
// Sandbox.execute() generates, so we can assert on URL rewrites without
// needing network access or exposing private methods.
// ---------------------------------------------------------------------------

let capturedCode: string;
let originalFunction: typeof Function;

beforeEach(() => {
  capturedCode = "";
  originalFunction = globalThis.Function;

  // The sandbox calls `new Function(...argNames, code)` — the last argument
  // is always the code body. We capture it and throw to prevent actual eval.
  globalThis.Function = new Proxy(originalFunction, {
    construct(_target, args) {
      capturedCode = String(args[args.length - 1] ?? "");
      // Throw a non-SyntaxError sentinel so execute() does NOT fall through
      // to the async eval path (which would trigger real import() calls).
      throw new Error("__SANDBOX_TEST_INTERCEPT__");
    },
  });
});

afterEach(() => {
  globalThis.Function = originalFunction;
});

/**
 * Helper: run Sandbox.execute() on the given code, swallow the sentinel error,
 * and return the transpiled code body that was captured by the Function proxy.
 * @returns The transpiled code string.
 */
async function transpiled(code: string): Promise<string> {
  const sandbox = new Sandbox();
  try {
    await sandbox.execute(code);
  } catch {
    // Expected — we intercept Function construction
  }
  return capturedCode;
}

// ---------------------------------------------------------------------------
// Dynamic import() rewriting
// ---------------------------------------------------------------------------

describe("dynamic import rewriting", () => {
  it("rewrites bare specifier in dynamic import", async () => {
    const code = await transpiled('const m = await import("dayjs/plugin/duration");');
    expect(code).toContain('import("https://esm.sh/dayjs/plugin/duration")');
  });

  it("rewrites simple package name", async () => {
    const code = await transpiled('const m = await import("lodash");');
    expect(code).toContain('import("https://esm.sh/lodash")');
  });

  it("rewrites scoped package", async () => {
    const code = await transpiled('const m = await import("@scope/pkg");');
    expect(code).toContain('import("https://esm.sh/@scope/pkg")');
  });

  it("rewrites scoped package with subpath", async () => {
    const code = await transpiled('const m = await import("@scope/pkg/sub/path");');
    expect(code).toContain('import("https://esm.sh/@scope/pkg/sub/path")');
  });

  it("does NOT rewrite relative paths", async () => {
    const code = await transpiled('const m = await import("./local.js");');
    expect(code).toContain('import("./local.js")');
    expect(code).not.toContain("esm.sh");
  });

  it("does NOT rewrite absolute URLs", async () => {
    const code = await transpiled('const m = await import("https://cdn.example.com/lib.js");');
    expect(code).toContain('import("https://cdn.example.com/lib.js")');
    // should have only the original URL, no double esm.sh prefix
    expect(code).not.toContain("esm.sh");
  });

  it("does NOT rewrite template literal arguments", async () => {
    const code = await transpiled("const m = await import(`dayjs/plugin/${name}`);");
    expect(code).not.toContain("esm.sh");
  });

  it("rewrites nested dynamic imports inside functions", async () => {
    const input = `
async function load() {
  const m = await import("react-dom/client");
  return m;
}`;
    const code = await transpiled(input);
    expect(code).toContain('import("https://esm.sh/react-dom/client")');
  });

  it("rewrites dynamic import in .then() chain", async () => {
    const code = await transpiled('import("dayjs/plugin/duration").then(m => m.default);');
    expect(code).toContain('import("https://esm.sh/dayjs/plugin/duration")');
  });

  it("handles multiple dynamic imports in same code", async () => {
    const input = `
const a = await import("react");
const b = await import("lodash");
const c = await import("./local.js");
`;
    const code = await transpiled(input);
    expect(code).toContain('import("https://esm.sh/react")');
    expect(code).toContain('import("https://esm.sh/lodash")');
    expect(code).toContain('import("./local.js")');
  });
});

// ---------------------------------------------------------------------------
// Static import rewriting (regression — ensure still works)
// ---------------------------------------------------------------------------

describe("static import rewriting", () => {
  it("rewrites default import to esm.sh", async () => {
    const code = await transpiled('import duration from "dayjs/plugin/duration";');
    expect(code).toContain('import("https://esm.sh/dayjs/plugin/duration")');
  });

  it("rewrites named imports to esm.sh", async () => {
    const code = await transpiled('import { useState, useEffect } from "react";');
    expect(code).toContain('import("https://esm.sh/react")');
  });

  it("rewrites namespace import to esm.sh", async () => {
    const code = await transpiled('import * as R from "ramda";');
    expect(code).toContain('import("https://esm.sh/ramda")');
  });

  it("does NOT rewrite relative static imports", async () => {
    const code = await transpiled('import foo from "./foo";');
    expect(code).toContain('import("./foo")');
    expect(code).not.toContain("esm.sh");
  });
});
