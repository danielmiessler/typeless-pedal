// Keyboard entry point, run by the Hammerspoon adapter (keyboard/typeless_keys.lua),
// which swallows the physical Right Ctrl+J and sends one line per event over a
// Unix socket:
//   down [keyEventTimestamp]
//   up <heldMs>
// It stays running because timing matters: the start tap must reach Typeless before
// J starts auto-repeating (~225ms), and spawning a fresh process per press lost that
// race about half the time.
import { chmodSync, rmSync } from "node:fs";
import { press, release, log } from "./dictate.ts";
import { releaseKeyboardShortcut, uptimeNs } from "./keystroke.ts";

export const SOCKET = `${process.env.HOME}/Library/Application Support/TypelessPedal/keyboard.sock`;

// "down" may carry the key event's timestamp, in mach ticks on Apple silicon (24 MHz)
// or nanoseconds elsewhere; take whichever reading lands in the last few seconds.
function keyTime(raw: string | undefined): bigint | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const now = uptimeNs(), t = BigInt(raw);
  for (const ns of [(t * 125n) / 3n, t]) if (ns <= now && now - ns < 5_000_000_000n) return ns;
}

async function handle(line: string) {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === "down") {
    releaseKeyboardShortcut();
    await press("keyboard", keyTime(arg));
  } else if (cmd === "up") {
    await release("keyboard", Number(arg) || 0);
  }
}

await Bun.$`mkdir -p ${SOCKET.slice(0, SOCKET.lastIndexOf("/"))}`.quiet();
rmSync(SOCKET, { force: true });
const buffers = new WeakMap<object, string>();
Bun.listen({
  unix: SOCKET,
  socket: {
    data(sock, chunk) {
      let buf = (buffers.get(sock) ?? "") + chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        // Not awaited: a release waiting on Typeless's paste must not delay the next press.
        handle(line).catch((e) => log(`keyboard error: ${e}`));
      }
      buffers.set(sock, buf);
    },
  },
});
chmodSync(SOCKET, 0o600);
log("keyboard listener started");
