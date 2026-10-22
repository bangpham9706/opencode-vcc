/**
 * opencode-vcc — an algorithmic conversation compactor for OpenCode.
 *
 * Port of pi-vcc (https://github.com/sting8k/pi-vcc, MIT): a deterministic,
 * no-LLM session compactor. It hooks OpenCode's compaction request, builds a
 * structured summary from the transcript, and keeps a stable, session-global
 * `#N` index so the dropped history stays reachable through the `vcc_recall`
 * tool and the `/vcc-recall` command.
 *
 * Wire-up:
 *   - compaction hook   → src/compact/hook.ts
 *   - vcc_recall tool   → src/recall/tool.ts
 *   - /vcc, /vcc-recall → src/command/vcc.ts
 */
import { Plugin } from "@opencode/plugin";
import { loadSettings } from "./oc/settings";
import { writeDebug } from "./oc/debug";
import { SnapStore } from "./oc/snapstore";
import { pendingVcc } from "./oc/pending";
import { createCompactionHandler } from "./compact/hook";
import { registerRecallTool } from "./recall/tool";
import { registerVccCommands } from "./command/vcc";

export const plugin = Plugin.define({
  id: "opencode-vcc",
  async setup(ctx) {
    const settings = loadSettings(ctx.options);
    const store = new SnapStore(ctx.storage);
    const handler = createCompactionHandler(settings, store, pendingVcc);

    // The hook mutates `event.result` in place: OpenCode then skips its own
    // summarizer and uses our summary (and our metadata.keepID) as-is.
    const compaction = await ctx.session.hook("compaction", async (event) => {
      await handler(event);
    });

    await registerRecallTool(ctx);
    await registerVccCommands(ctx);

    if (settings.debug) {
      // A registration the host rejects is silent, so debug mode reports what
      // is actually live.
      writeDebug(settings, { options: ctx.options ?? {} });
      try {
        const tools = await ctx.tool.list();
        const commands = await ctx.command.list();
        writeDebug(settings, {
          registeredTools: tools.map((t) => t.id),
          registeredCommands: commands.data.map((c) => c.name),
        });
      } catch (error) {
        writeDebug(settings, { registrationError: String(error) });
      }
    }

    return async () => {
      await compaction.dispose();
    };
  },
});

export default plugin;