/**
 * Port of pi-vcc's render-entries.ts to OpenCode's canonical message shape.
 *
 * One RenderedEntry per SummaryMessage — the same unit the compaction hook
 * sees, so `#N` refs emitted into summaries land on the entry that produced
 * them. OpenCode keeps tool results as parts of assistant messages; the
 * renderer folds completed results into the summary (`[name] result`) the way
 * pi-vcc rendered toolResult messages.
 */
import type { SummaryMessage, SummaryPart } from "../types";
import { clip, textOf } from "./content";
import { summarizeToolArgs, extractPath } from "./tool-args";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
}

type ToolCallPart = Extract<SummaryPart, { type: "tool-call" }>;
type ToolResultPart = Extract<SummaryPart, { type: "tool-result" }>;

const toolCallParts = (msg: SummaryMessage): ToolCallPart[] => {
  if (typeof msg.content === "string") return [];
  return msg.content.filter((p): p is ToolCallPart => p.type === "tool-call");
};

const toolResultParts = (msg: SummaryMessage): ToolResultPart[] => {
  if (typeof msg.content === "string") return [];
  return msg.content.filter((p): p is ToolResultPart => p.type === "tool-result");
};

const toolCalls = (msg: SummaryMessage): string => {
  return toolCallParts(msg)
    .map((c) => `${c.name}(${summarizeToolArgs(c.input)})`)
    .join(", ");
};

const extractFilesFromContent = (msg: SummaryMessage): string[] => {
  return toolCallParts(msg)
    .map((c) => extractPath(c.input))
    .filter((p): p is string => p !== null);
};

export const renderMessage = (msg: SummaryMessage, index: number, full = false): RenderedEntry => {
  if (msg.role === "tool") {
    const results = toolResultParts(msg)
      .map((p) => {
        const raw = p.text;
        const resultText = full ? raw : clip(raw, 200);
        return `[${p.name ?? "tool"}] ${resultText}`;
      })
      .join("\n");
    return { index, role: "tool", summary: results };
  }
  if (msg.role !== "assistant") {
    const text = full ? textOf(msg) : clip(textOf(msg), 300);
    return { index, role: msg.role, summary: text };
  }

  const text = full ? textOf(msg) : clip(textOf(msg), 300);
  const tools = toolCalls(msg);
  const files = extractFilesFromContent(msg);
  const results = toolResultParts(msg)
    .map((p) => {
      const raw = p.text;
      const resultText = full ? raw : clip(raw, 200);
      return `[${p.name ?? "tool"}] ${resultText}`;
    })
    .join("\n");
  const summary = [tools, text, results].filter(Boolean).join("\n");
  return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};
