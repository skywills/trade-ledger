export class WriterQueue {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  enqueue<T>(operation: () => T): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("The storage writer queue is closed."));
    }

    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }
}
