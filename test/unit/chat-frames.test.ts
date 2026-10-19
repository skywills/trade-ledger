import { describe, expect, it } from "vitest";
import {
  type ChatFrame,
  ThreadEventBus,
} from "../../src/server/chat/frames.js";

describe("bounded chat fanout", () => {
  it("limits subscribers and releases a disconnected subscriber", () => {
    const bus = new ThreadEventBus();
    const releases = Array.from({ length: 8 }, () =>
      bus.subscribe("t", () => {}),
    );
    expect(() => bus.subscribe("t", () => {})).toThrow();
    releases[0]?.();
    expect(() => bus.subscribe("t", () => {})).not.toThrow();
  });

  it("keeps the global subscriber count accurate when deletion closes streams", () => {
    const bus = new ThreadEventBus();
    for (let t = 0; t < 8; t++)
      for (let i = 0; i < 8; i++) {
        let release = () => {};
        release = bus.subscribe(String(t), () => {}, {
          onClose: () => release(),
        });
      }
    expect(() => bus.subscribe("extra", () => {})).toThrow();
    bus.clear("0");
    for (let i = 0; i < 8; i++) bus.subscribe("replacement", () => {});
    expect(() => bus.subscribe("extra", () => {})).toThrow();
  });

  it("bounds replay bytes while continuing live delivery", () => {
    const bus = new ThreadEventBus();
    let delivered = 0;
    bus.subscribe("t", () => {
      delivered += 1;
    });
    for (let i = 0; i < 20; i++)
      bus.emit("t", {
        event: "delta",
        data: { messageId: "m", text: "x".repeat(32000) },
      });
    const frames: ChatFrame[] = [];
    bus.subscribe("t", (f) => frames.push(f));
    expect(delivered).toBe(20);
    expect(Buffer.byteLength(JSON.stringify(frames))).toBeLessThan(270000);
  });

  it("evicts old replay when the cached thread bound is reached", () => {
    const bus = new ThreadEventBus();
    for (let i = 0; i < 129; i++)
      bus.emit(String(i), {
        event: "delta",
        data: { messageId: "m", text: String(i) },
      });
    const oldest: ChatFrame[] = [];
    const newest: ChatFrame[] = [];
    bus.subscribe("0", (f) => oldest.push(f));
    bus.subscribe("128", (f) => newest.push(f));
    expect(oldest).toEqual([]);
    expect(newest).toEqual([
      { event: "delta", data: { messageId: "m", text: "128" } },
    ]);
  });

  it("retains ordered bounded replay and resets it for the next turn", () => {
    const bus = new ThreadEventBus();
    for (let i = 0; i < 2100; i++)
      bus.emit("t", {
        event: "delta",
        data: { messageId: "m", text: String(i) },
      });
    const frames: ChatFrame[] = [];
    const release = bus.subscribe("t", (f) => frames.push(f));
    expect(frames).toHaveLength(2000);
    expect(frames[0]).toMatchObject({ data: { text: "100" } });
    expect(frames.at(-1)).toMatchObject({ data: { text: "2099" } });
    release();
    bus.resetReplay("t");
    const next: ChatFrame[] = [];
    bus.subscribe("t", (f) => next.push(f));
    expect(next).toEqual([]);
  });
});
