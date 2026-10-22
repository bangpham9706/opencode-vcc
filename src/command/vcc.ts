/**
 * The `/vcc` and `/vcc-recall` commands, ported from pi-vcc's commands/.
 *
 * `/vcc [keep:N] [prompt]` records the request in the pending map and asks
 * OpenCode to compact; its compaction hook (src/compact/hook.ts) reads the
 * request and produces the structured summary. A follow-up prompt, if given,
 * is sent after the compaction is queued.
 *
 * `/vcc-recall [query] [scope:all] [page:N]` runs recall and injects the result
 * as a synthetic context message — OpenCode's counterpart of pi's
 * `sendMessage({display:true})`, without triggering a turn.
 */
import type { Plugin } from "@opencode/plugin";
import { parseKeepAndPrompt } from "../core/compact-args";
import { parseCommandRequest } from "../core/recall-request";
import { runRecall, type RecallPagingHints } from "../core/recall-run";
import { setPendingVcc } from "../oc/pending";
import { openView } from "../recall/view";

const scopeArg = (scope: string) => (scope === "all" ? " scope:all" : "");

const COMMAND_PAGING_HINTS: RecallPagingHints = {
  outOfRange: (query, scope, totalPages, truncated) =>
    `Use /vcc-recall ${query}${scopeArg(scope)} page:N with N between 1 and ${totalPages}` +
    (truncated ? "." : ", or refine your query."),
  nextPage: (query, scope, page) => `\n--- /vcc-recall ${query}${scopeArg(scope)} page:${page} ---`,
};

export const registerVccCommands = async (ctx: Plugin.Context): Promise<void> => {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "vcc",
      description: "Compact the conversation with opencode-vcc structured summary",
      async execute(input) {
        const args = input.prompt?.text ?? "";
        const { followUpPrompt, keepUserTurns, keepUserTurnsExplicit } = parseKeepAndPrompt(args);
        // The compaction hook reads this request when the compaction runs.
        setPendingVcc(input.sessionID, {
          keepUserTurns: keepUserTurns ?? 1,
          keepUserTurnsExplicit,
          followUpPrompt,
        });
        await ctx.session.compact({ sessionID: input.sessionID });
        if (followUpPrompt) {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: followUpPrompt,
            delivery: input.delivery,
          });
        }
      },
    });

    editor.add({
      name: "vcc-recall",
      description:
        "Recall earlier parts of this session. Plain keywords work best; the session is linear, so scope:all is only for compatibility.",
      async execute(input) {
        const args = input.prompt?.text ?? "";
        const request = parseCommandRequest(args);
        const view = await openView(ctx, input.sessionID, request.scope);
        const text = await runRecall(request, view, COMMAND_PAGING_HINTS);
        await ctx.session.synthetic({ sessionID: input.sessionID, text, description: "vcc-recall" });
      },
    });
  });
};