/**
 * Port of pi-vcc's normalize.ts to OpenCode's canonical message shape.
 * OpenCode's user-side shell/skill/synthetic translations arrive as role
 * "user" with distinctive text; a user shell-command text is rendered as a
 * `bash` block so tracked commands and the brief keep treating it exactly
 * like pi-vcc's bashExecution messages.
 */
import type { NormalizedBlock, SummaryMessage } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

/** OpenCode's to-LLM translation of a user-run shell message. */
export const SHELL_USER_PREFIX = "The following shell command was executed by the user:";

/** Parse the shell-command user text into command + output, or null. */
export const parseShellUserText = (text: string): { command: string; output: string } | null => {
  if (!text.startsWith(SHELL_USER_PREFIX)) return null;
  const commandMatch = /\n\s*Command:\n([\s\S]*?)(?:\n\nOutput:|$)/.exec(text);
  if (!commandMatch) return null;
  const outputMatch = /\n\nOutput:\n?([\s\S]*)$/.exec(text);
  return { command: (commandMatch[1] ?? "").trim(), output: (outputMatch?.[1] ?? "").trim() };
};

/** True when this user text is OpenCode's previous-compaction checkpoint. */
export const isCompactionCheckpoint = (text: string): boolean =>
  text.includes("<conversation-checkpoint>") && (text.includes("<summary>") || text.includes("<recent-context>"));

/** The summary text of a previous compaction rendered into context, without wrapper tags. */
export const summaryOfCheckpoint = (text: string): string | undefined => {
  const m = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(text);
  return m ? m[1] : undefined;
};

/**
 * The verbatim kept tail inside a previous checkpoint. Re-extracted fresh on
 * the next compaction so older tail details survive without re-summarizing the
 * previous summary itself (that one is carried by mergePrevious instead).
 */
export const recentContextOfCheckpoint = (text: string): string | undefined => {
  const m = /<recent-context>\n?([\s\S]*?)\n?<\/recent-context>/.exec(text);
  return m ? m[1] : undefined;
};

const normalizeOne = (msg: SummaryMessage, msgIndex: number | undefined): NormalizedBlock[] => {
  const parts = typeof msg.content === "string" ? null : msg.content;
  const seen: NormalizedBlock[] = [];

  if (msg.role === "system") return [];

  if (msg.role === "tool") {
    for (const part of parts ?? []) {
      if (part.type === "tool-result") {
        seen.push({ kind: "tool_result", name: part.name ?? "tool", text: sanitize(part.text), sourceIndex: msgIndex });
      } else if (part.type === "text") {
        seen.push({ kind: "assistant", text: sanitize(part.text), sourceIndex: msgIndex });
      }
    }
    return seen;
  }

  if (msg.role === "user") {
    const text = sanitize(textOf(msg));
    const shell = parseShellUserText(text);
    if (shell && textOf(msg).length < 20_000) {
      seen.push({ kind: "bash", command: shell.command, output: shell.output, exitCode: undefined, sourceIndex: msgIndex });
      return seen;
    }
    if (isCompactionCheckpoint(text)) {
      // Render the historic summary as user context, like pi-vcc renders
      // branch summaries — delegates/dedups handle it downstream.
      seen.push({ kind: "user", text: text, sourceIndex: msgIndex });
      return seen;
    }
    if (text) seen.push({ kind: "user", text, sourceIndex: msgIndex });
    return seen.length > 0 ? seen : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  for (const part of parts ?? []) {
    if (part.type === "text") {
      seen.push({ kind: msg.role === "assistant" ? "assistant" : "user", text: sanitize(part.text), sourceIndex: msgIndex });
    } else if (part.type === "tool-call") {
      seen.push({
        kind: "tool_call",
        name: part.name,
        args: part.input,
        sourceIndex: msgIndex,
      });
    } else if (part.type === "tool-result") {
      seen.push({
        kind: "tool_result",
        name: part.name ?? "tool",
        text: sanitize(part.text),
        sourceIndex: msgIndex,
      });
    }
  }
  return seen;
};

/**
 * Normalize messages to blocks. `sourceIndices`, when provided, supplies the
 * session-global `#N` index per input position (see src/oc/indices.ts).
 * A missing entry yields `sourceIndex: undefined`, which downstream renderers
 * display as no ref — never a window-relative number.
 */
export const normalize = (
  messages: readonly SummaryMessage[],
  sourceIndices?: ReadonlyArray<number | undefined>,
): NormalizedBlock[] =>
  messages.flatMap((msg, i) => normalizeOne(msg, sourceIndices ? sourceIndices[i] : i));
