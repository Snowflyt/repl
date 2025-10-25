<h1 align="center">JS/TS REPL</h1>

<p align="center">
  An online <strong>REPL</strong> for <strong>JavaScript/TypeScript</strong>.
</p>

![screenshot](./screenshots/screenshot.png)

## Features

- **Interactively** execute <del>any</del> almost any JavaScript/TypeScript code directly in your browser.
- _(Type annotations are stripped before execution, and no type checking is performed.)_
- Beautiful output with **syntax highlighting** (powered by [highlight.js](https://github.com/highlightjs/highlight.js)) and **pretty-printing** (enabled by [showify](https://github.com/Snowflyt/showify)).
- **Import any NPM package** directly with `import` statements (powered by [esm.sh](https://esm.sh/)).
- **Auto-completion (intellisense)** powered by the TypeScript language service running in a Web Worker. Third-party type definitions are automatically fetched when importing NPM packages (powered by [@typescript/ata](https://www.npmjs.com/package/@typescript/ata)).
- **Shareable** links to your REPL, with history encoded in the URL.
- **Top-level `await`** is supported, and can be cancelled using <kbd>Ctrl</kbd> + <kbd>C</kbd>.
- Conveniently **copy** and **jump to previous inputs** using the buttons on the right side of the input field, and easily **navigate through your history** with the <kbd>↑</kbd> and <kbd>↓</kbd> keys.
- **REPL commands** for extra functionality:
  - `:check <code>` or `:c <code>` to get the type of an expression without executing it.
  - `:type <TypeExpr>` or `:t <TypeExpr>` to get the evaluated type of a TypeScript type expression.
- **Clear history** with `clear()` or `console.clear()`.
- Full support for the **`console` API**, including methods like `console.dir()`, `console.group()`, `console.table()`, `console.time()`, etc.
- **Responsive** layout, optimized for mobile devices.

## Limitations

### Simulated Global Scope

This REPL simulates rather than implements a true global scope, which affects how closures work between separate evaluations. For example:

```javascript
const f = () => value; // First evaluation
const value = 42; // Second evaluation
f(); // Third evaluation - ReferenceError!
```

**Behavior explanation:**

- When pasted as a single block, this code works as expected because it’s evaluated together.
- When run line-by-line, it fails because each line is evaluated in its own isolated context.

**Technical details:** Each code snippet is processed as follows:

- The TypeScript compiler API analyzes the code.
- Top-level variables are extracted to a shared context object.
- This context is passed to subsequent evaluations.

This effectively transforms the above example into something like:

```javascript
const context = {};

const updateContext = (obj) => {
  for (const key in obj) {
    context[key] = obj[key];
  }
};

updateContext(
  new Function(
    ...Object.keys(context),
    `
      const f = () => value;
      return { f };
    `,
  )(...Object.values(context)),
);

updateContext(
  new Function(
    ...Object.keys(context),
    `
      const value = 42;
      return { value };
    `,
  )(...Object.values(context)),
);

updateContext(
  new Function(
    ...Object.keys(context),
    `
      const __repl_result___ = f();
      return { __repl_result___ };
    `,
  )(...Object.values(context)),
);
console.log(context.__repl_result___);
```

Since the `value` variable is not defined in the first snippet of code, the `f` function will throw a ReferenceError when it’s called.
