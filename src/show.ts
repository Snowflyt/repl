import type { ShowOptions } from "showify";
import { Node as SerializerNode, serializer, show as showify } from "showify";

const { pair, text } = SerializerNode;

const promiseResults = new WeakMap<
  Promise<unknown>,
  { type: "pending" } | { type: "fulfilled"; value: unknown } | { type: "rejected"; value: unknown }
>();

export function show(value: unknown, options: ShowOptions = {}): string {
  return showify(value, {
    indent: 2,
    depth: 4,
    colors: true,

    serializers: [
      serializer({
        if: (value) => value instanceof Promise,
        then: (promise, { ancestors, c, level }, expand) => {
          if (!promiseResults.has(promise)) {
            promiseResults.set(promise, { type: "pending" });
            promise
              .then((value) => {
                promiseResults.set(promise, { type: "fulfilled", value });
              })
              .catch((error: unknown) => {
                promiseResults.set(promise, { type: "rejected", value: error });
              });
          }

          const result = promiseResults.get(promise)!;

          const node = expand(promise, { level, ancestors: [...ancestors], serializers: [] });
          (node as any).values[2].inline.values[0] = (node as any).values[2].wrap.values[0] =
            result.type === "pending" ? text(c.special("<pending>"))
            : result.type === "fulfilled" ? expand(result.value)
            : pair(text(c.special("<rejected> ")), expand(result.value));

          return node;
        },
      }),

      serializer({
        if: (value) => value instanceof Response,
        then: (response, _options, expand) =>
          pair(
            text((Object.getPrototypeOf(response).constructor.name as string) + " "),
            expand(
              Object.fromEntries(
                (
                  [
                    "type",
                    "url",
                    "redirected",
                    "status",
                    "ok",
                    "statusText",
                    "headers",
                    "body",
                    "bodyUsed",
                  ] as const
                ).map((key) => [key, response[key]]),
              ),
            ),
          ),
      }),

      serializer({
        if: (value) => value instanceof ReadableStream,
        then: (stream, _options, expand) =>
          pair(
            text((Object.getPrototypeOf(stream).constructor.name as string) + " "),
            expand(Object.fromEntries((["locked"] as const).map((key) => [key, stream[key]]))),
          ),
      }),

      serializer({
        if: (value) => value instanceof Headers,
        then: (headers, _options, expand) => {
          return pair(
            text(
              (Object.getPrototypeOf(headers).constructor.name as string) +
                `(${[...headers.keys()].length.toString()}) `,
            ),
            expand(Object.fromEntries([...headers.entries()])),
          );
        },
      }),
    ],

    ...options,
  });
}

export function showTable(data: object, properties: string[]): string {
  const primitiveColumn = Symbol("primitiveColumn");
  let columns = properties as (string | typeof primitiveColumn)[] | undefined;
  if (!columns) {
    columns = [];
    let hasPrimitive = false;
    for (const key in data)
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value: unknown = data[key as keyof typeof data];
        if (value === null || typeof value !== "object") {
          hasPrimitive = true;
        } else {
          for (const key in value)
            if (Object.prototype.hasOwnProperty.call(value, key)) columns.push(key);
        }
      }
    if (hasPrimitive) columns.push(primitiveColumn);
  }

  let indexWidth = "(index)".length;
  const columnWidths = columns.reduce(
    (acc, key) => ({ ...acc, [key]: (key === primitiveColumn ? "Values" : key).length }),
    {} as Record<string | typeof primitiveColumn, number>,
  );
  const table = {} as Record<string, { [K in string | typeof primitiveColumn]?: unknown }>;
  for (const key in data) {
    indexWidth = Math.max(indexWidth, key.length);
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const value: unknown = data[key as keyof typeof data];
      if (value === null || typeof value !== "object") {
        if (columns.includes(primitiveColumn)) {
          columnWidths[primitiveColumn] = Math.max(
            columnWidths[primitiveColumn],
            show(value, { indent: 0, colors: false }).length,
          );
          table[key] = { [primitiveColumn]: value };
        }
      } else {
        table[key] = {};
        for (const column of columns.filter((key) => key !== primitiveColumn)) {
          if (Object.prototype.hasOwnProperty.call(value, column)) {
            const val: unknown = value[column as keyof typeof value];
            columnWidths[column] = Math.max(
              columnWidths[column]!,
              show(val, { indent: 0, colors: false }).length,
            );
            table[key][column] = val;
          }
        }
      }
    }
  }

  let output =
    "┌" +
    "─".repeat(indexWidth + 2) +
    Object.values(columnWidths).reduce((acc, width) => acc + "┬" + "─".repeat(width + 2), "") +
    (columns.includes(primitiveColumn) ? "┬" + "─".repeat(columnWidths[primitiveColumn] + 2) : "") +
    "┐\n";
  output +=
    "│ (index)" +
    " ".repeat(indexWidth - "(index)".length) +
    " │" +
    Object.entries(columnWidths).reduce(
      (acc, [key, width]) => acc + " " + key + " ".repeat(width - key.length) + " │",
      "",
    ) +
    (columns.includes(primitiveColumn) ?
      " Values" + " ".repeat(columnWidths[primitiveColumn] - "Values".length) + " │"
    : "") +
    "\n";
  output +=
    "├" +
    "─".repeat(indexWidth + 2) +
    Object.values(columnWidths).reduce((acc, width) => acc + "┼" + "─".repeat(width + 2), "") +
    (columns.includes(primitiveColumn) ? "┼" + "─".repeat(columnWidths[primitiveColumn] + 2) : "") +
    "┤\n";
  for (const key in table) {
    const values = table[key]!;
    output +=
      "│ " +
      key +
      " ".repeat(indexWidth - key.length) +
      " │" +
      Object.entries(columnWidths).reduce((acc, [column, width]) => {
        if (!(column in values)) return acc + " ".repeat(width + 2) + "│";
        const val = values[column]!;
        const valWidth = show(val, { indent: 0, colors: false }).length;
        return acc + " " + show(val, { indent: 0 }) + " ".repeat(width - valWidth) + " │";
      }, "") +
      (columns.includes(primitiveColumn) ?
        " " +
        (primitiveColumn in values ?
          show(values[primitiveColumn], { indent: 0 }) +
          " ".repeat(
            columnWidths[primitiveColumn] -
              show(values[primitiveColumn], { indent: 0, colors: false }).length,
          )
        : " ".repeat(columnWidths[primitiveColumn])) +
        " │"
      : "") +
      "\n";
  }
  output +=
    "└" +
    "─".repeat(indexWidth + 2) +
    Object.values(columnWidths).reduce((acc, width) => acc + "┴" + "─".repeat(width + 2), "") +
    (columns.includes(primitiveColumn) ? "┴" + "─".repeat(columnWidths[primitiveColumn] + 2) : "") +
    "┘";

  return output;
}
