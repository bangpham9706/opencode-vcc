/**
 * Cross-module state for an in-flight `/vcc` compaction. The `/vcc` command
 * records the request here and then asks OpenCode to compact; the compaction
 * hook (a different registration, no shared context) reads and clears it. The
 * plugin is a single instance per server, so one module-level map is enough.
 */
export interface PendingVcc {
  keepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  followUpPrompt: string;
  /** When the request was recorded; a stale entry is ignored (see PENDING_TTL_MS). */
  at: number;
}

/**
 * A request older than this is treated as absent. OpenCode may refuse to
 * compact (nothing to compact) without ever running the hook; without the
 * expiry that stale keep:N would silently apply to the next, unrelated
 * automatic compaction.
 */
export const PENDING_TTL_MS = 120_000;

export const pendingVcc = new Map<string, PendingVcc>();

/** Record a `/vcc` request for a session. */
export const setPendingVcc = (sessionID: string, request: Omit<PendingVcc, "at">): void => {
  pendingVcc.set(sessionID, { ...request, at: Date.now() });
};

/**
 * Take the pending request for a session, if there is a fresh one. Returns
 * undefined (and drops the stale entry) when there is nothing to apply.
 */
export const takePendingFrom = (
  pending: Map<string, PendingVcc>,
  sessionID: string,
  now = Date.now(),
): PendingVcc | undefined => {
  const entry = pending.get(sessionID);
  if (!entry) return undefined;
  if (now - entry.at > PENDING_TTL_MS) {
    pending.delete(sessionID);
    return undefined;
  }
  pending.delete(sessionID);
  return entry;
};

/** `takePendingFrom` for the module-level map. */
export const takePendingVcc = (sessionID: string, now = Date.now()): PendingVcc | undefined =>
  takePendingFrom(pendingVcc, sessionID, now);
