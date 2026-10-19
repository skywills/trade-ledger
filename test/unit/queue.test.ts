import { describe, expect, it } from "vitest";
import { WriterQueue } from "../../src/server/storage/queue.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("WriterQueue", () => {
  it("runs operations in acceptance order without overlapping pending work", async () => {
    const queue = new WriterQueue();
    const started = gate();
    const finish = gate();
    const events: string[] = [];
    const first = queue.enqueue(async () => {
      events.push("first started");
      started.release();
      await finish.promise;
      events.push("first finished");
      return "first result";
    });
    const second = queue.enqueue(() => {
      events.push("second started");
      return 42;
    });

    await started.promise;
    expect(events).toEqual(["first started"]);
    finish.release();

    await expect(first).resolves.toBe("first result");
    await expect(second).resolves.toBe(42);
    expect(events).toEqual([
      "first started",
      "first finished",
      "second started",
    ]);
    await queue.close();
  });

  it.each(["throw", "reject"] as const)(
    "continues queued work after an operation fails by %s",
    async (failure) => {
      const queue = new WriterQueue();
      const error = new Error("write failed");
      const events: string[] = [];
      const failed = queue.enqueue(() => {
        events.push("failed operation");
        if (failure === "throw") throw error;
        return Promise.reject(error);
      });
      const next = queue.enqueue(() => {
        events.push("next operation");
        return "saved";
      });

      await expect(failed).rejects.toBe(error);
      await expect(next).resolves.toBe("saved");
      await expect(queue.drain()).resolves.toBeUndefined();
      expect(events).toEqual(["failed operation", "next operation"]);
      await queue.close();
    },
  );

  it("drains accepted work while continuing to accept later operations", async () => {
    const queue = new WriterQueue();
    const firstStarted = gate();
    const finishFirst = gate();
    const secondStarted = gate();
    const finishSecond = gate();
    queue.enqueue(async () => {
      firstStarted.release();
      await finishFirst.promise;
    });
    await firstStarted.promise;

    let drained = false;
    const draining = queue.drain().then(() => {
      drained = true;
    });
    let secondFinished = false;
    const second = queue.enqueue(async () => {
      secondStarted.release();
      await finishSecond.promise;
      secondFinished = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishFirst.release();
    await draining;
    await secondStarted.promise;
    expect(secondFinished).toBe(false);
    finishSecond.release();
    await second;
    await expect(queue.enqueue(() => "still accepting")).resolves.toBe(
      "still accepting",
    );
    await queue.close();
  });

  it("lets drain finish after a rejected operation", async () => {
    const queue = new WriterQueue();
    const finish = gate();
    const failed = queue.enqueue(async () => {
      await finish.promise;
      throw new Error("write failed");
    });
    const rejection = expect(failed).rejects.toThrow("write failed");
    const draining = queue.drain();
    finish.release();

    await rejection;
    await expect(draining).resolves.toBeUndefined();
    await queue.close();
  });

  it("rejects new work as soon as close starts and drains every accepted operation", async () => {
    const queue = new WriterQueue();
    const firstStarted = gate();
    const finishFirst = gate();
    const secondStarted = gate();
    const finishSecond = gate();
    const first = queue.enqueue(async () => {
      firstStarted.release();
      await finishFirst.promise;
      return "first saved";
    });
    const second = queue.enqueue(async () => {
      secondStarted.release();
      await finishSecond.promise;
      return "second saved";
    });
    await firstStarted.promise;
    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    let rejectedWorkRan = false;
    await expect(
      queue.enqueue(() => {
        rejectedWorkRan = true;
      }),
    ).rejects.toThrow(/closed/);
    expect(rejectedWorkRan).toBe(false);
    expect(closed).toBe(false);

    finishFirst.release();
    await secondStarted.promise;
    expect(closed).toBe(false);
    finishSecond.release();
    await expect(first).resolves.toBe("first saved");
    await expect(second).resolves.toBe("second saved");
    await closing;
    await expect(queue.enqueue(() => "too late")).rejects.toThrow(/closed/);
    await expect(queue.close()).resolves.toBeUndefined();
  });
});
