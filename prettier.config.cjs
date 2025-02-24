// @ts-check

module.exports = /** @satisfies {import("prettier").Config} */ ({
  arrowParens: "always",
  bracketSameLine: true,
  bracketSpacing: true,
  experimentalTernaries: true,
  plugins: ["prettier-plugin-packagejson", "prettier-plugin-tailwindcss"],
  semi: true,
  singleQuote: false,
  tailwindFunctions: ["clsx"],
  tailwindStylesheet: "./src/styles.css",
  trailingComma: "all",
  printWidth: 100,
});
