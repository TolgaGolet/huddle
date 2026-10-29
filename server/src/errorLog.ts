/**
 * A loggable description of a thrown value: the error name plus the stack
 * frames (code locations). The message and the stack's first line are
 * omitted because they can quote user input (names, chat text, passwords).
 */
export function errorSummary(err: unknown): { name: string; frames?: string } {
  if (!(err instanceof Error)) return { name: typeof err };
  const frames = err.stack
    ?.split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, 8)
    .join("\n");
  return { name: err.name, frames };
}
