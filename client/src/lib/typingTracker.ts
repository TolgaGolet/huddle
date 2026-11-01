/** Auto-expiry for a user who stops typing without sending (e.g. closes the tab). */
const TYPING_EXPIRY_MS = 5000;

/** Who else is typing, keyed by userId. The server only relays, so timeouts live here. */
export class TypingTracker {
  private typing = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();

  /** `onChange` receives the names, most recent first. */
  constructor(private readonly onChange: (names: string[]) => void) {}

  private publish(): void {
    this.onChange([...this.typing.values()].map((u) => u.name).reverse());
  }

  started(userId: string, name: string): void {
    const existing = this.typing.get(userId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.typing.delete(userId);
      this.publish();
    }, TYPING_EXPIRY_MS);
    this.typing.set(userId, { name, timer });
    // A repeat only restarts the expiry: the published names would be identical.
    if (!existing) this.publish();
  }

  /** Their message arrived, or they left. */
  clear(userId: string): void {
    const entry = this.typing.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.typing.delete(userId);
    this.publish();
  }

  dispose(): void {
    for (const { timer } of this.typing.values()) clearTimeout(timer);
    this.typing.clear();
  }
}
