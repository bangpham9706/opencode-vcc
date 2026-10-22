/**
 * The OpenCode boundary: translate the LLM messages a compaction hook receives
 * (@opencode/ai `Message`, structurally typed here so the pure core stays
 * dependency-free) into the canonical SummaryMessage the extraction core reads.
 */
import type { SummaryMessage, SummaryPart } from "../types";
import { IMAGE_CONTENT_CHARS } from "../core/token-estimate";
import { SHELL_USER_PREFIX } from "../core/normalize";

/** Structural subset of @opencode/ai's Message. */
export interface OcLLMMessage {
  id?: string;
  role?: string;
  content?: unknown;
}

interface OcPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  filename?: string;
  media?: { mediaType?: string; mimeType?: string };
  result?: { type?: string; value?: unknown };
  [key: string]: unknown;
}

const asArray = (content: unknown): OcPart[] => {
  if (Array.isArray(content)) return content as OcPart[];
  return [];
};

const jsonify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "") ?? "";
  } catch {
    return "";
  }
};

/** Flatten an OpenCode tool result value ({type,value}) to text. */
export const toolResultToText = (result: OcPart["result"]): string => {
  if (!result) return "";
  const { type, value } = result;
  if (type === "content") {
    if (!Array.isArray(value)) return "";
    return value
      .map((item) => {
        const content = item as { type?: string; text?: string; mime?: string; name?: string };
        if (content.type === "text") return content.text ?? "";
        return `[Attached ${content.mime ?? "file"}${content.name ? `: ${content.name}` : ""}]`;
      })
      .join("\n");
  }
  return jsonify(value);
};

/** Map one raw part; unknown parts carrying text degrade to text parts. */
const mapPart = (part: OcPart): SummaryPart | null => {
  switch (part.type) {
    case "text":
      return { type: "text", text: typeof part.text === "string" ? part.text : "" };
    case "reasoning":
      return { type: "reasoning", text: typeof part.text === "string" ? part.text : "" };
    case "media":
      return {
        type: "media",
        mime: part.media?.mediaType ?? part.media?.mimeType ?? "application/octet-stream",
        filename: part.filename,
      };
    case "tool-call":
      return {
        type: "tool-call",
        callId: part.id,
        name: typeof part.name === "string" ? part.name : "tool",
        input: (part.input && typeof part.input === "object" ? part.input : {}) as Record<string, unknown>,
      };
    case "tool-result":
      return {
        type: "tool-result",
        callId: part.id,
        name: typeof part.name === "string" ? part.name : undefined,
        status: part.result?.type === "error" ? "error" : "completed",
        text: toolResultToText(part.result),
      };
    case "compaction":
      // Native provider window: not textual, so nothing to summarize.
      return null;
    default:
      if (typeof part.text === "string") return { type: "text", text: part.text };
      return null;
  }
};

/** True when any message carries a native compaction part. */
export const hasNativeCompaction = (messages: readonly OcLLMMessage[]): boolean =>
  messages.some((msg) => asArray(msg.content).some((part) => part.type === "compaction"));

/**
 * Translate the hook's transcript into canonical messages, ids preserved.
 * A message with an unusable id gets an empty id: the hook then refuses to
 * emit `keepID` for it rather than pointing OpenCode at the wrong message.
 */
export const toSummaryMessages = (messages: readonly OcLLMMessage[]): SummaryMessage[] =>
  messages.map((msg, i) => {
    const role = msg.role === "user" || msg.role === "assistant" || msg.role === "system" || msg.role === "tool"
      ? msg.role
      : "assistant";
    const id = typeof msg.id === "string" && msg.id.length > 0 ? msg.id : "";
    if (typeof msg.content === "string") return { id, role, content: msg.content };
    const parts = asArray(msg.content).map(mapPart).filter((p): p is SummaryPart => p !== null);
    return { id, role, content: parts };
  });

/** Char estimate of one canonical message, mirroring the host estimator. */
export const estimateMessageChars = (msg: SummaryMessage): number => {
  if (typeof msg.content === "string") return msg.content.length;
  return msg.content.reduce((sum, part) => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return sum + part.text.length;
      case "media": {
        const mime = part.mime.toLowerCase();
        return sum + (mime.startsWith("image/") || mime === "application/pdf" ? IMAGE_CONTENT_CHARS : 0);
      }
      case "tool-call":
        return sum + part.name.length + jsonify(part.input).length;
      case "tool-result":
        return sum + part.text.length;
      default:
        return sum;
    }
  }, 0);
};

export const estimateMessagesChars = (messages: readonly SummaryMessage[]): number =>
  messages.reduce((sum, msg) => sum + estimateMessageChars(msg), 0);

// ── durable session stream → canonical (the recall "live" side) ────────────

/**
 * Structural subset of the durable SessionMessageInfo the server returns from
 * `ctx.session.context()`. Kept structural so the pure core never imports the
 * client package.
 */
export interface OcSessionMessage {
  id?: string;
  type?: string;
  // user / synthetic / system / skill
  text?: string;
  // user attachments
  files?: Array<{ name?: string; mime?: string }>;
  // shell
  command?: string;
  output?: { output?: string };
  // compaction
  status?: string;
  summary?: string;
  // assistant
  content?: Array<{
    type?: string;
    id?: string;
    name?: string;
    text?: string;
    state?: {
      status?: string;
      input?: unknown;
      content?: unknown;
      error?: unknown;
    };
  }>;
}

const toolContentToText = (content: unknown): string => {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((item) => {
      const c = item as { type?: string; text?: string; mime?: string; name?: string };
      if (c.type === "text") return c.text ?? "";
      return `[Attached ${c.mime ?? "file"}${c.name ? `: ${c.name}` : ""}]`;
    })
    .filter(Boolean)
    .join("\n");
};

const errorToText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return jsonify(error);
};

/** OpenCode's durable shell message, rendered as the text normalise() parses. */
const shellMessageText = (command: string, output: string): string =>
  `${SHELL_USER_PREFIX}\n\nCommand:\n${command}\n\nOutput:\n${output}`;

const sessionOne = (msg: OcSessionMessage): SummaryMessage | null => {
  const id = typeof msg.id === "string" ? msg.id : "";
  switch (msg.type) {
    case "user":
    case "synthetic":
    case "skill": {
      let text = typeof msg.text === "string" ? msg.text : "";
      if (msg.type === "user" && Array.isArray(msg.files) && msg.files.length > 0) {
        text += `\n${msg.files.map((f) => `[Attached ${f.mime ?? "file"}${f.name ? `: ${f.name}` : ""}]`).join("\n")}`;
      }
      return { id, role: "user", content: text };
    }
    case "system":
      return { id, role: "system", content: typeof msg.text === "string" ? msg.text : "" };
    case "shell":
      return {
        id,
        role: "user",
        content: shellMessageText(
          typeof msg.command === "string" ? msg.command : "",
          typeof msg.output?.output === "string" ? msg.output.output : "",
        ),
      };
    case "compaction":
      // Only a completed compaction is real history; running/failed have no text.
      return msg.status === "completed" && typeof msg.summary === "string"
        ? { id, role: "user", content: `<conversation-checkpoint>\n<summary>\n${msg.summary}\n</summary>\n</conversation-checkpoint>` }
        : null;
    case "assistant": {
      const parts: SummaryPart[] = [];
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (part.type === "text") {
          parts.push({ type: "text", text: typeof part.text === "string" ? part.text : "" });
        } else if (part.type === "reasoning") {
          parts.push({ type: "reasoning", text: typeof part.text === "string" ? part.text : "" });
        } else if (part.type === "tool") {
          const state = part.state ?? {};
          parts.push({
            type: "tool-call",
            callId: part.id,
            name: typeof part.name === "string" ? part.name : "tool",
            input: (state.input && typeof state.input === "object" ? state.input : {}) as Record<string, unknown>,
          });
          if (state.status === "completed") {
            parts.push({ type: "tool-result", callId: part.id, name: part.name, status: "completed", text: toolContentToText(state.content) });
          } else if (state.status === "error") {
            parts.push({ type: "tool-result", callId: part.id, name: part.name, status: "error", text: errorToText(state.error) });
          }
        }
      }
      return { id, role: "assistant", content: parts };
    }
    default:
      // agent-switched, model-switched, location-switched, idle — no context text.
      return null;
  }
};

/** Translate the durable session stream into canonical messages, order kept. */
export const sessionMessagesToSummary = (messages: readonly OcSessionMessage[]): SummaryMessage[] =>
  messages.map(sessionOne).filter((m): m is SummaryMessage => m !== null);