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

    const variables: string[] = [];
    let codeToExecute = "";

    // Traverse every statement in the AST
    for (let i = 0; i < sourceFile.statements.length; i++) {
      const statement = sourceFile.statements[i]!;
      const isLast = i === sourceFile.statements.length - 1;

      Array.prototype.push.apply(variables, this.#extractDeclaredVariables(statement));

      if (
        isLast &&
        !ts.isVariableStatement(statement) &&
        !ts.isFunctionDeclaration(statement) &&
        !ts.isClassDeclaration(statement) &&
        !this.#isControlFlowStatement(statement)
      ) {
        codeToExecute +=
          "const __repl_result___ = " + this.#removeModuleSyntax(statement.getText());
        variables.push("__repl_result___");
      } else {
        codeToExecute += this.#removeModuleSyntax(statement.getText());
      }
    }

    codeToExecute += `; return { ${variables.join(", ")} };`;

    let result: Record<string, unknown>;
    try {
      result = this.#evalSync("return (() => { " + codeToExecute + " })();") as never;
    } catch (error) {
      if (error instanceof SyntaxError)
        result = (await this.#evalAsync(
          "return await (async () => { " + codeToExecute + " })();",
        )) as never;
      else throw error;
    }

    for (const [key, value] of Object.entries(result)) {
      if (key === "__repl_result___") continue;
      this.#context[key] = value;
    }

    return "__repl_result___" in result ? Option.some(result.__repl_result___) : Option.none();
  }

  /**
   * Extracts all variable names declared in a statement, including nested destructuring patterns.
   * @param statement The TypeScript statement to analyze.
   * @returns An array of declared variable names.
   */
  #extractDeclaredVariables(statement: ts.Statement): string[] {
    const variables: string[] = [];

    // Handle variable declarations (let, const, var)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        this.#extractBindingNames(declaration.name, variables);
      }
    }
    // Handle function declarations
    else if (ts.isFunctionDeclaration(statement) && statement.name) {
      variables.push(statement.name.text);
    }
    // Handle class declarations
    else if (ts.isClassDeclaration(statement) && statement.name) {
      variables.push(statement.name.text);
    }

    return variables;
  }

  /**
   * Recursively extracts names from a binding pattern (identifier, object or array pattern).
   * @param bindingName The binding pattern node.
   * @param variables Array to collect variable names.
   */
  #extractBindingNames(bindingName: ts.BindingName, variables: string[]): void {
    // Simple variable names
    if (ts.isIdentifier(bindingName)) {
      variables.push(bindingName.text);
    }
    // Object destructuring (const { a, b: c, ...rest } = ...)
    else if (ts.isObjectBindingPattern(bindingName)) {
      for (const element of bindingName.elements)
        this.#extractBindingNames(element.name, variables);
    }
    // Array destructuring (const [, b, ...rest] = ...)
    else if (ts.isArrayBindingPattern(bindingName)) {
      for (const element of bindingName.elements) {
        if (ts.isOmittedExpression(element)) {
          // Skip empty slots [, , c]
          continue;
        }
        this.#extractBindingNames(element.name, variables);
      }
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
   * Replace module syntax with whitespace from a JavaScript statement.
   * @param statement The statement to process.
   * @returns The processed statement.
   */
  #removeModuleSyntax(statement: string): string {
    // Remove export and default keywords
    // (Replace with spaces to keep error message positions consistent)
    statement = statement.replace(/^(\s*export\s+)default(\s+)/, "$1      $2");
    statement = statement.replace(/^(\s*)export(\s+)/, "$1      $2");
    return statement;
  }

  /**
   * Evaluate a snippet of synchronous JavaScript code.
   * @param code The code to evaluate.
   * @returns The result of the evaluation.
   */
  #evalSync(code: string): unknown {
    const context = this.#prepareFunctionContext();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(...Object.keys(context), code)(...Object.values(context));
  }

  /**
   * Evaluate a snippet of asynchronous JavaScript code.
   * @param code The code to evaluate.
   * @returns The result of the evaluation.
   */
  async #evalAsync(code: string): Promise<unknown> {
    const context = this.#prepareFunctionContext();
    return await new AsyncFunction(...Object.keys(context), code)(...Object.values(context));
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
