import type { SummaryMessage, SummaryPart } from "../../src/types";
import type { CutItem } from "../../src/compact/cut";
import { isCompactionCheckpoint, SHELL_USER_PREFIX } from "../../src/core/normalize";
import { textOf } from "../../src/core/content";
import type { StorageDomain } from "@opencode/plugin/promise/storage";

export const user = (id: string, text = "hi"): SummaryMessage => ({ id, role: "user", content: text });

export const assistant = (id: string, text = "ok"): SummaryMessage => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }],
});

export const toolResult = (id: string, name: string, text: string, callId = "tc_1"): SummaryMessage => ({
  id,
  role: "tool",
  content: [{ type: "tool-result", callId, name, status: "completed", text }],
});

export const assistantTool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  opts: { callId?: string; result?: string } = {},
): SummaryMessage => {
  const callId = opts.callId ?? "tc_1";
  const parts: SummaryPart[] = [{ type: "tool-call", callId, name, input }];
  if (opts.result !== undefined) {
    parts.push({ type: "tool-result", callId, name, status: "completed", text: opts.result });
  }
  return { id, role: "assistant", content: parts };
};

export const shell = (id: string, command: string, output = ""): SummaryMessage => ({
  id,
  role: "user",
  content: `${SHELL_USER_PREFIX}\n\nCommand:\n${command}\n\nOutput:\n${output}`,
});

export const checkpoint = (id: string, summary: string, recent?: string): SummaryMessage => ({
  id,
  role: "user",
  content: [
    "<conversation-checkpoint>",
    "The following is a summary and serialized record of earlier conversation.",
    "",
    `<summary>\n${summary}\n</summary>`,
    ...(recent ? ["", `<recent-context>\n${recent}\n</recent-context>`] : []),
    "</conversation-checkpoint>",
  ].join("\n"),
});

export const cutItems = (messages: SummaryMessage[]): CutItem[] =>
  messages.map((message) => ({
    id: message.id,
    message,
    checkpoint: message.role === "user" && isCompactionCheckpoint(textOf(message)),
  }));

/** An in-memory StorageDomain with prefix scans, for store/hook/recall tests. */
export const memoryStorage = (): StorageDomain => {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      return data.get(key) as never;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
    async scan({ prefix, after, limit }) {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after === undefined ? 0 : keys.findIndex((k) => k > after);
      const slice = (start < 0 ? [] : keys.slice(start)).slice(0, limit ?? keys.length);
      return {
        entries: slice.map((key) => ({ key, value: data.get(key) as never })),
        next: start >= 0 && start + slice.length < keys.length ? slice[slice.length - 1] : undefined,
      };
    },
  };
};