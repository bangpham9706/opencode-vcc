/**
 * The `vcc_recall` tool. Same surface as pi-vcc's tools/recall.ts, wired to
 * OpenCode's tool registry via `ctx.tool.transform((editor) => editor.add(...))`.
 *
 * The input is a plain JSON Schema (the plugin API accepts one directly), and
 * `execute` repairs repairable argument mistakes with `normalizeToolParams`
 * before parsing, so a `"#12"` string or a reversed range never surfaces as a
 * schema error.
 */
import type { Plugin } from "@opencode/plugin";
import { normalizeToolParams, parseToolRequest } from "../core/recall-request";
import { invalidExpandIndices, runRecall, type RecallPagingHints } from "../core/recall-run";
import { openView } from "./view";

export { invalidExpandIndices };

const TOOL_PAGING_HINTS: RecallPagingHints = {
  outOfRange: (_query, _scope, totalPages, truncated) => truncated
    ? `Use a page between 1 and ${totalPages}.`
    : `Use a page between 1 and ${totalPages}, or refine your query.`,
  nextPage: (_query, scope, page) => `\n--- Use page:${page}${scope === "all" ? " with scope:'all'" : ""} for more results ---`,
  skipCurrentTurn: true,
  aroundHit: (n, scope) =>
    `\n--- Read around a hit: range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: expand:[${n}]${scope === "all" ? " (with scope:'all')" : ""} ---`,
};

const DESCRIPTION = [
  "Recall earlier parts of this session, including anything dropped by compaction.",
  "Use it before saying the context is gone.",
  "",
  "Pick one per call:",
  "- query: keyword search (regex works), 5 results per page.",
  "- range: [from, to]: entries #from..#to in order, 20 per page.",
  "- expand: [N, ...]: full untruncated text of those entries.",
  "- mode: 'touched': files worked on, with entry indices.",
  "- query '#N:path': file content from entry N ('#N:path:full' for all lines).",
  "",
  "Add to any of them:",
  "- page: next page of query, range or touched results.",
  "- scope: OpenCode sessions are linear, so 'lineage' (default) and 'all' read",
  "  the same history; 'all' is accepted for compatibility.",
  "",
  "#N is the number shown in summary refs like (#12) and in recall results.",
  "Only the current session is searchable.",
].join("\n");

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N.",
    },
    range: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "[from, to]: every entry from #from to #to (inclusive) in order, 20 per page. #N is the number in summary refs like (#12) and in recall results.",
    },
    expand: {
      type: "array",
      items: { type: "number" },
      description: "#N indices to return full untruncated content for (from summary refs like (#12) or recall results).",
    },
    page: {
      type: "number",
      description: "Page number (1-based) for query, range or touched results. Default: 1.",
    },
    scope: {
      type: "string",
      enum: ["lineage", "all"],
      description:
        "Accepted for pi-vcc compatibility. OpenCode sessions are linear, so both read the same history.",
    },
    mode: {
      type: "string",
      enum: ["hybrid", "touched"],
      description:
        "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices. The touched list misses files written via patch tools (paths inside the diff) or bash redirects.",
    },
  },
  additionalProperties: false,
} as const;

export const registerRecallTool = async (ctx: Plugin.Context): Promise<void> => {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "vcc_recall",
      description: DESCRIPTION,
      input: INPUT_SCHEMA as unknown as Record<string, unknown>,
      async execute(input, context) {
        const request = parseToolRequest(normalizeToolParams(input) as never);
        const view = await openView(ctx, context.sessionID, request.scope);
        const text = await runRecall(request, view, TOOL_PAGING_HINTS);
        return { content: text };
      },
    });
  });
};