/**
 * ModelContent has no slot for reasoning, so the agent loop hands back assistant turns without it.
 * Both APIs want it back on tool-call turns (Anthropic: signed thinking blocks; DeepSeek-style
 * servers: reasoning_content). We keep what the server produced, keyed by each tool call id, and
 * the request builders restore it when the same calls come back.
 */
export class ReplayCache<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly max = 512) {}

  set(callIds: string[], value: T): void {
    for (const id of callIds) {
      this.map.delete(id);
      this.map.set(id, value);
    }
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** The stored value when every id maps to the same entry, else undefined. */
  get(callIds: string[]): T | undefined {
    if (callIds.length === 0) return undefined;
    const first = this.map.get(callIds[0] as string);
    return first !== undefined && callIds.every((id) => this.map.get(id) === first) ? first : undefined;
  }
}
