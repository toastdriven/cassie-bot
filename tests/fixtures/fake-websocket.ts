// A minimal stand-in for the global `WebSocket` that Bot depends on, for
// tests that don't want a real network connection. Implements only the
// surface Bot actually uses: construct with a URL, assign onmessage/
// onerror/onclose, send(), close(). Tests drive the fake end by calling
// emitMessage()/emitClose() directly -- there's no real socket underneath.
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  sent: string[] = [];
  closed = false;

  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emitClose();
  }

  // --- test-side helpers, not part of the real WebSocket surface ---

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }

  emitClose(): void {
    this.onclose?.();
  }

  // The last frame sent, parsed back from JSON -- convenience for
  // assertions, since Bot always sends JSON text frames.
  lastSentFrame(): unknown {
    const last = this.sent[this.sent.length - 1];
    return last === undefined ? undefined : JSON.parse(last);
  }
}

// Swaps the global WebSocket for FakeWebSocket for the duration of a test,
// and clears FakeWebSocket.instances so each test starts clean. Returns a
// restore function; call it in `afterEach`/at the end of the test.
export function installFakeWebSocket(): () => void {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  // @ts-expect-error -- FakeWebSocket is intentionally not a full WebSocket.
  globalThis.WebSocket = FakeWebSocket;

  return () => {
    globalThis.WebSocket = original;
  };
}
