import { Option } from "effect";
import tsBlankSpace from "ts-blank-space";
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
      "temp.js",
      tsBlankSpace(code),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );

    // Traverse every statement in the AST
    for (let i = 0; i < sourceFile.statements.length; i++) {
      const statement = sourceFile.statements[i]!;
      const isLast = i === sourceFile.statements.length - 1;

      if (ts.isVariableStatement(statement)) {
        await this.#processVariableStatement(statement);
        continue;
      }

      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        await this.#processFunctionOrClassDeclaration(statement);
        continue;
      }

      if (this.#isControlFlowStatement(statement)) {
        await this.#run(statement.getText());
        continue;
      }

      // Process as an expression; return its result
      const result = (await this.#eval(statement.getText())).result;
      if (isLast) return Option.some(result);
    }

    return Option.none();
  }

  async #processVariableStatement(statement: ts.VariableStatement): Promise<void> {
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) throw new Error("Variable declaration must have an initializer");

      const evalRes = (await this.#eval(decl.initializer.getText())).result;

      if (ts.isObjectBindingPattern(decl.name)) {
        await this.#processObjectDestructuring(decl.name, evalRes);
      } else if (ts.isArrayBindingPattern(decl.name)) {
        await this.#processArrayDestructuring(decl.name, evalRes);
      } else {
        const varName = decl.name.getText();
        if (typeof evalRes === "function")
          Object.defineProperty(evalRes, "name", { value: varName, configurable: true });
        this.#context[varName] = evalRes;
      }
    }
  }

  async #processObjectDestructuring(
    binding: ts.ObjectBindingPattern,
    evalRes: unknown,
  ): Promise<void> {
    const assignedProps = new Set<string>();
    for (const element of binding.elements) {
      // Rest element (e.g., ...rest)
      if (element.dotDotDotToken) {
        const varName = element.name.getText();
        const rest: Record<string, unknown> = {};
        for (const key in evalRes as any) {
          if (!assignedProps.has(key)) {
            rest[key] = (evalRes as any)[key];
          }
        }
        this.#context[varName] = rest;
        continue;
      }

      // Determine the property key and the extracted value
      let key: string;
      let value: unknown;
      if (element.propertyName) {
        // For renaming: { original: alias = default }
        key = element.propertyName.getText();
        value = (evalRes as any)[key];
      } else {
        // For shorthand: { foo = default }
        key = element.name.getText();
        value = (evalRes as any)[key];
      }

      // If value is undefined and a default initializer exists, evaluate the default.
      if (value === undefined && element.initializer)
        value = (await this.#eval(element.initializer.getText())).result;

      // If there is a nested binding pattern, process it recursively.
      if (ts.isObjectBindingPattern(element.name)) {
        await this.#processObjectDestructuring(element.name, value);
      } else if (ts.isArrayBindingPattern(element.name)) {
        await this.#processArrayDestructuring(element.name, value);
      } else {
        // Finally assign value to context.
        const varName = element.name.getText();
        this.#context[varName] = value;
      }
      // Track the property as processed.
      assignedProps.add(key);
    }
  }

  async #processArrayDestructuring(
    binding: ts.ArrayBindingPattern,
    evalRes: unknown,
  ): Promise<void> {
    if (!Array.isArray(evalRes)) throw new Error("Array destructuring assignment must be an array");

    let index = 0;
    for (const element of binding.elements) {
      // Skip omitted expressions (e.g., [ , a ])
      if (ts.isOmittedExpression(element)) {
        index++;
        continue;
      }
      // Rest element (e.g., ...rest)
      if (element.dotDotDotToken) {
        const varName = element.getText().replace("...", "").trim();
        this.#context[varName] = (evalRes as any).slice(index);
      } else {
        const varName = element.name.getText();
        let value = (evalRes as any)[index];
        // Handle default initializer if value is undefined
        if (value === undefined && element.initializer)
          value = (await this.#eval(element.initializer.getText())).result;
        // If there is a nested binding pattern, process it recursively.
        if (ts.isObjectBindingPattern(element.name)) {
          await this.#processObjectDestructuring(element.name, value);
        } else if (ts.isArrayBindingPattern(element.name)) {
          await this.#processArrayDestructuring(element.name, value);
        } else {
          // Finally assign the value to the context.
          this.#context[varName] = value;
        }
        index++;
      }
    }
  }

  async #processFunctionOrClassDeclaration(
    statement: ts.FunctionDeclaration | ts.ClassDeclaration,
  ): Promise<void> {
    const name = statement.name?.getText();
    if (name) {
      this.#context[name] = (await this.#eval(statement.getText())).result;
    }
  }

  #isControlFlowStatement(statement: ts.Statement): boolean {
    // List of control flow syntax kinds
    const controlFlowKinds = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.BreakStatement,
      ts.SyntaxKind.ContinueStatement,
      ts.SyntaxKind.DebuggerStatement,
      ts.SyntaxKind.DoStatement,
      ts.SyntaxKind.EmptyStatement,
      ts.SyntaxKind.ForStatement,
      ts.SyntaxKind.ForInStatement,
      ts.SyntaxKind.ForOfStatement,
      ts.SyntaxKind.IfStatement,
      ts.SyntaxKind.LabeledStatement,
      ts.SyntaxKind.NotEmittedStatement,
      ts.SyntaxKind.ReturnStatement,
      ts.SyntaxKind.SwitchStatement,
      ts.SyntaxKind.ThrowStatement,
      ts.SyntaxKind.TryStatement,
      ts.SyntaxKind.WhileStatement,
      ts.SyntaxKind.WithStatement,
    ]);
    if (controlFlowKinds.has(statement.kind)) return true;

    // Check if the statement is an expression statement calling `console` or `clear`
    if (ts.isExpressionStatement(statement)) {
      const expr = statement.expression;
      if (ts.isCallExpression(expr)) {
        // If it’s a property access (e.g., console.log)
        if (ts.isPropertyAccessExpression(expr.expression)) {
          const target = expr.expression.expression;
          if (ts.isIdentifier(target) && target.text === "console") return true;
        }
        // If it’s a call to an identifier (e.g., clear())
        else if (ts.isIdentifier(expr.expression) && expr.expression.text === "clear") return true;
      }
    }
    return false;
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

  /**
   * Run a JavaScript statement.
   * @param code The code to run.
   */
  async #run(code: string): Promise<void> {
    code = this.#processStatement(code).trim();
    if (!code) return;

    const context = this.#prepareFunctionContext();
    await new AsyncFunction(...Object.keys(context), code)(...Object.values(context));
  }

  /**
   * Evaluate a JavaScript expression.
   * @param code The code to evaluate.
   * @returns The result of the evaluation.
   */
  async #eval(code: string): Promise<{ result: unknown }> {
    code = this.#processStatement(code);

    const context = this.#prepareFunctionContext();
    try {
      return {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        result: new Function(...Object.keys(context), `return (${code})`)(
          ...Object.values(context),
        ),
      };
    } catch (error) {
      if (error instanceof SyntaxError)
        return {
          result: await new AsyncFunction(...Object.keys(context), `return (${code})`)(
            ...Object.values(context),
          ),
        };
      throw error;
    }
  }

  /**
   * Replace module syntax and trailing semicolons with whitespace from a statement.
   * @param statement The statement to process.
   * @returns The processed statement.
   */
  #processStatement(statement: string): string {
    // Remove export and default keywords
    // (Replace with spaces to keep error message positions consistent)
    statement = statement.replace(/^(\s*export\s+)default(\s+)/, "$1      $2");
    statement = statement.replace(/^(\s*)export(\s+)/, "$1      $2");

    // Replace trailing semicolon with a space
    let trimmed = statement.trimEnd();
    while (trimmed.endsWith(";")) {
      statement = trimmed.slice(0, -1) + " " + statement.slice(trimmed.length + 1);
      trimmed = statement.trimEnd();
    }

    return statement;
  }

  /**
   * Prepare the function context for execution.
   * @returns
   */
  #prepareFunctionContext(): Record<string, unknown> {
    return {
      globals: this.#context,
      console: this.#mockConsole,
      clear: this.#mockConsole.clear,
      ...this.#context,
    };
  }
}
