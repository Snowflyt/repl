import { Option } from "effect";
import * as ts from "typescript";

const AsyncFunction = async function () {}.constructor as FunctionConstructor;

export type ConsoleListener = <Type extends Exclude<keyof Console, "Console">>(
  type: Type,
  ...args: Parameters<Console[Type]>
) => void;

export class Sandbox {
  #context: Record<string, unknown> = {};

  #consoleListeners: ConsoleListener[] = [];
  #mockConsole = new Proxy(console, {
    get: (target, prop, receiver) => {
      if (typeof prop !== "string" || typeof (console as any)[prop] !== "function")
        return Reflect.get(target, prop, receiver);
      return Object.defineProperty(
        (...args: unknown[]) => {
          this.#consoleListeners.forEach((listener) => listener(prop as any, ...args));
        },
        "name",
        { value: prop, configurable: true },
      );
    },
  });

  /**
   * Execute code in the sandbox.
   * @param code The code to execute.
   * @returns
   */
  async execute(code: string): Promise<Option.Option<unknown>> {
    const sourceFile = ts.createSourceFile(
      "temp.ts",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const statements = sourceFile.statements
      .map((statement) =>
        ts.createPrinter().printNode(ts.EmitHint.Unspecified, statement, sourceFile),
      )
      .map(
        (statement) =>
          ts.transpileModule(statement, {
            compilerOptions: {
              module: ts.ModuleKind.Preserve,
              target: ts.ScriptTarget.Latest,
            },
          }).outputText,
      )
      .map((statement) => {
        statement = statement.replace(/^\s*(export\s+(default\s+)?)?/, "").trimEnd();
        while (statement.endsWith(";")) statement = statement.slice(0, -1).trimEnd();
        return statement;
      })
      .filter(Boolean);

    for (let i = 0; i < statements.length; i++) {
      const code = statements[i]!;
      const isLast = i === statements.length - 1;

      // Variable declaration
      let match = /^(?:const|let|var)\s+([^\s=]+)/.exec(code);
      if (match) {
        const name = match[1]!;
        const value = code.replace(/^(?:const|let|var)\s+[^\s=]+\s*=\s*/, "");
        const result = (await this.#eval(value)).result;
        if (typeof result === "function")
          // Add name to function
          Object.defineProperty(result, "name", { value: name, configurable: true });
        this.#context[name] = result;
        if (isLast) return Option.none();
        continue;
      }

      // Function or class declaration
      match = /^(?:(?:async\s+)?function(?:(?:\s*\*\s*)|\s+)|class\s+)([^\s({]+)/.exec(code);
      if (match) {
        const name = match[1]!;
        this.#context[name] = (await this.#eval(code)).result;
        if (isLast) return Option.none();
        continue;
      }

      // Statement
      if (
        /^console\s*\.\s*[a-z][a-zA-Z]+\s*\(/.test(code) ||
        /^clear\s*\(\s*\)$/.test(code) ||
        /^(?:if|else|for|while|do|switch|try|catch|finally|return|throw|break|continue)\b/.test(
          code,
        )
      ) {
        await this.#run(code);
        if (isLast) return Option.none();
        continue;
      }

      // Expression
      const result = (await this.#eval(code)).result;
      if (isLast) return Option.some(result);
    }

    return Option.none();
  }

  /**
   * Register a console listener.
   * @param listener The listener.
   */
  addConsoleListener(listener: ConsoleListener): void {
    this.#consoleListeners.push(listener);
  }
  /**
   * Remove a console listener.
   * @param listener The listener.
   */
  removeConsoleListener(listener: ConsoleListener): void {
    this.#consoleListeners = this.#consoleListeners.filter((l) => l !== listener);
  }

  async #run(code: string): Promise<void> {
    await new AsyncFunction("console", "clear", ...Object.keys(this.#context), code)(
      this.#mockConsole,
      this.#mockConsole.clear,
      ...Object.values(this.#context),
    );
  }

  async #eval(code: string): Promise<{ result: unknown }> {
    try {
      return {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        result: new Function("console", "clear", ...Object.keys(this.#context), `return (${code})`)(
          this.#mockConsole,
          this.#mockConsole.clear,
          ...Object.values(this.#context),
        ),
      };
    } catch (error) {
      if (error instanceof SyntaxError)
        return {
          result: await new AsyncFunction(
            "console",
            "clear",
            ...Object.keys(this.#context),
            `return (${code})`,
          )(this.#mockConsole, this.#mockConsole.clear, ...Object.values(this.#context)),
        };
      throw error;
    }
  }
}
