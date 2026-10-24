/** A shared concurrency budget with cancellable queued work. */
export class WorkQueue {
  private active = 0;
  private readonly pending: (() => void)[] = [];

  public constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new Error("Concurrency must be a positive integer.");
  }

  public run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.pending.indexOf(start);
        if (index >= 0) this.pending.splice(index, 1);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Queued work cancelled."),
        );
      };
      const start = () => {
        signal?.removeEventListener("abort", cancel);
        this.active += 1;
        void Promise.resolve()
          .then(() => {
            signal?.throwIfAborted();
            return work();
          })
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.pending.shift()?.();
          });
      };
      if (this.active < this.concurrency) start();
      else {
        this.pending.push(start);
        signal?.addEventListener("abort", cancel, { once: true });
      }
    });
  }
}
