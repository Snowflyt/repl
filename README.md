<h1 align="center">JS/TS REPL</h1>

<p align="center">
  An online <strong>REPL</strong> for <strong>JavaScript/TypeScript</strong>.
</p>

![screenshot](./screenshots/screenshot.png)

## Features

- **Interactively** execute any JavaScript/TypeScript code directly in your browser.
- _(Type annotations are stripped before execution, and no type checking is performed.)_
- Beautiful output with **syntax highlighting** (powered by [highlight.js](https://github.com/highlightjs/highlight.js)) and **pretty-printing** (enabled by [showify](https://github.com/Snowflyt/showify)).
- Import any NPM package directly with `import` statements (powered by [jsdelivr](https://www.jsdelivr.com/)).
- **Top-level `await`** is supported, and can be cancelled using <kbd>Ctrl</kbd> + <kbd>C</kbd>.
- Conveniently **copy** and **jump to previous inputs** using the buttons on the right side of the input field, and easily **navigate through your history** with the <kbd>↑</kbd> and <kbd>↓</kbd> keys.
- **Clear history** with `clear()` or `console.clear()`.
- Full support for the **`console` API**, including methods like `console.dir()`, `console.group()`, `console.table()`, `console.time()`, etc.
- **Responsive** layout, optimized for mobile devices.
