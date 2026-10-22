/**
 * Durable index store for opencode-vcc. pi-vcc numbered entries across the
 * session JSONL file; OpenCode keeps pre-compaction messages out of the live
 * context, so the port persists what it is about to drop:
 *
 *   vcc/index/<sessionID>          → { nextIndex }            the #N counter
 *   vcc/entry/<sessionID>/<idx>    → StoredEntry              one indexed message
 *   vcc/compact/<sessionID>/<id>   → CompactionRecord         one compaction
 *
 * `#N` is stable and session-global: an index is assigned once, when a message
 * is first indexed, and never reused. Recall merges these stored entries with
 * the live context, exactly like pi-vcc merged JSONL windows.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage";
import type { SummaryMessage } from "../types";

/** The storage domain's JSON value type, without importing effect directly. */
type JsonValue = Parameters<StorageDomain["set"]>[1];

export interface StoredEntry {
  idx: number;
  id: string;
  message: SummaryMessage;
}

export interface CompactionRecord {
  time: number;
  reason: string;
  sections: string[];
  summarized: number;
  kept: number;
  keptTokensEst: number;
}

const INDEX_KEY = (sessionID: string) => `vcc/index/${sessionID}`;
const ENTRY_PREFIX = (sessionID: string) => `vcc/entry/${sessionID}/`;
const COMPACT_PREFIX = (sessionID: string) => `vcc/compact/${sessionID}/`;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class SnapStore {
  constructor(private readonly storage: StorageDomain) {}

  async getNextIndex(sessionID: string): Promise<number> {
    const raw = await this.storage.get(INDEX_KEY(sessionID));
    if (isRecord(raw) && typeof raw.nextIndex === "number" && Number.isFinite(raw.nextIndex) && raw.nextIndex >= 0) {
      return Math.floor(raw.nextIndex);
    }
    return 0;
  }

  async setNextIndex(sessionID: string, nextIndex: number): Promise<void> {
    await this.storage.set(INDEX_KEY(sessionID), { nextIndex: Math.max(0, Math.floor(nextIndex)) });
  }

  async getEntry(sessionID: string, idx: number): Promise<StoredEntry | undefined> {
    const raw = await this.storage.get(`${ENTRY_PREFIX(sessionID)}${idx}`);
    return isStoredEntry(raw) ? raw : undefined;
  }

  /** Every stored entry for a session, in #N order. */
  async listEntries(sessionID: string): Promise<StoredEntry[]> {
    const out: StoredEntry[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.storage.scan({ prefix: ENTRY_PREFIX(sessionID), after, limit: 500 });
      for (const entry of page.entries) {
        if (isStoredEntry(entry.value)) out.push(entry.value);
      }
      if (!page.next) break;
      after = page.next;
    }
    out.sort((a, b) => a.idx - b.idx);
    return out;
  }

  /** Persist entries for message ids that are not indexed yet, in order. */
  async indexMessages(sessionID: string, messages: ReadonlyArray<{ id: string; message: SummaryMessage }>): Promise<StoredEntry[]> {
    const existing = await this.listEntries(sessionID);
    const seen = new Set(existing.map((e) => e.id));
    let next = await this.getNextIndex(sessionID);
    const added: StoredEntry[] = [];
    for (const item of messages) {
      if (!item.id || seen.has(item.id)) continue;
      const entry: StoredEntry = { idx: next, id: item.id, message: item.message };
      await this.storage.set(`${ENTRY_PREFIX(sessionID)}${next}`, entry as unknown as JsonValue);
      seen.add(item.id);
      added.push(entry);
      next++;
    }
    if (added.length > 0) await this.setNextIndex(sessionID, next);
    return added;
  }

  /**
   * Index any unseen messages and return the id → #N map for exactly the
   * messages passed (existing entries keep their original index). Ids that are
   * empty are skipped and simply absent from the map.
   */
  async ensureIndexed(
    sessionID: string,
    messages: ReadonlyArray<{ id: string; message: SummaryMessage }>,
  ): Promise<Map<string, number>> {
    await this.indexMessages(sessionID, messages);
    const entries = await this.listEntries(sessionID);
    const byId = new Map(entries.map((e) => [e.id, e.idx]));
    const out = new Map<string, number>();
    for (const item of messages) {
      const idx = byId.get(item.id);
      if (idx !== undefined) out.set(item.id, idx);
    }
    return out;
  }

  /** The id → #N map for a session (stored entries only). */
  async indexMap(sessionID: string): Promise<Map<string, number>> {
    const entries = await this.listEntries(sessionID);
    return new Map(entries.map((e) => [e.id, e.idx]));
  }

  async putCompaction(sessionID: string, id: string, record: CompactionRecord): Promise<void> {
    await this.storage.set(`${COMPACT_PREFIX(sessionID)}${id}`, record as unknown as JsonValue);
  }

  async listCompactions(sessionID: string): Promise<CompactionRecord[]> {
    const out: CompactionRecord[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.storage.scan({ prefix: COMPACT_PREFIX(sessionID), after, limit: 100 });
      for (const entry of page.entries) {
        if (isRecord(entry.value) && typeof entry.value.time === "number" && Array.isArray(entry.value.sections)) {
          out.push(entry.value as unknown as CompactionRecord);
        }
      }
      if (!page.next) break;
      after = page.next;
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }
}

const isStoredEntry = (v: unknown): v is StoredEntry =>
  isRecord(v) &&
  typeof v.idx === "number" &&
  typeof v.id === "string" &&
  isRecord(v.message) &&
  typeof v.message.role === "string";

/** Recall page size knobs kept in one place for the store consumers. */
export const ENTRY_SCAN_LIMIT = 500;