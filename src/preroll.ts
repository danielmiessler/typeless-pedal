// Client for TypelessPreroll (preroll/), the helper that records the mic from the press
// and plays it to Typeless through a loopback device. Every call degrades to "no
// answer" (null) when the helper is not running, and dictation carries on without it.
const SOCKET = `${process.env.HOME}/Library/Application Support/TypelessPedal/preroll.sock`;

function ask(command: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    Bun.connect({
      unix: SOCKET,
      socket: {
        open(s) { s.write(`${command}\n`); },
        data(s, chunk) {
          buffer += chunk.toString();
          const i = buffer.indexOf("\n");
          if (i >= 0) { finish(buffer.slice(0, i)); s.end(); }
        },
        close() { finish(null); },
        error() { finish(null); },
        connectError() { finish(null); },
      },
    }).catch(() => finish(null));
  });
}

// Starts capture now. The reply only says whether the bridge is in use.
export const arm = () => ask("arm", 500);

export type Drained = { waitedMs: number; typelessRead: boolean; reply: string };

// Waits until everything said up to now has reached Typeless. Null: no bridge.
export async function drain(): Promise<Drained | null> {
  const reply = await ask("drain", 8000);
  const m = reply?.match(/^drained (\d+) read=([01])/);
  return m ? { waitedMs: Number(m[1]), typelessRead: m[2] === "1", reply: reply! } : null;
}

export const status = () => ask("status", 500);
