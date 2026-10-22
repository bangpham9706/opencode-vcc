/**
 * Build a RecallView for the live OpenCode session: read the current context,
 * translate it to canonical messages, and merge with the durable store.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage";
import { SnapStore } from "../oc/snapstore";
import { sessionMessagesToSummary, type OcSessionMessage } from "../oc/adapter";
import { openRecallView, type RecallView } from "./source";
import type { RecallScope } from "../core/recall-scope";

/** The slice of the plugin context recall needs. */
export interface RecallHost {
  readonly storage: StorageDomain;
  readonly session: {
    context: (input: { sessionID: string }) => Promise<readonly OcSessionMessage[]>;
  };
}

export const openView = async (
  host: RecallHost,
  sessionID: string,
  scope: RecallScope,
): Promise<RecallView> => {
  const live = sessionMessagesToSummary(await host.session.context({ sessionID }));
  const store = new SnapStore(host.storage);
  return openRecallView({ sessionID, store, live, scope });
};