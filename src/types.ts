/**
 * opencode-vcc — port of pi-vcc (https://github.com/sting8k/pi-vcc, MIT).
 * The extraction core is host-agnostic: it works on SummaryMessage/NormalizedBlock.
 * The OpenCode boundary lives in src/oc/.
 */

/** A canonical message for the summarizer, translated from OpenCode's LLM messages. */
export type SummaryMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | SummaryPart[];
};

export type SummaryPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "media"; mime: string; filename?: string }
  | { type: "tool-call"; callId?: string; name: string; input: Record<string, unknown> }
  | { type: "tool-result"; callId?: string; name?: string; status: "completed" | "error"; text: string };

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number };
