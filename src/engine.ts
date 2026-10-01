// Which dictation app the pedal and Right Ctrl+J drive. One word in ENGINE_FILE,
// "typeless" (the default) or "wispr", read on every press so switching needs no
// restart. The preroll helper reads the same file (preroll/main.go).
//   bun src/engine.ts          prints the engine
//   bun src/engine.ts wispr    switches to Wispr Flow
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const ENGINE_FILE = `${process.env.HOME}/Library/Application Support/TypelessPedal/engine`;

export type Engine = {
  name: "typeless" | "wispr";
  label: string;
  // Fragment of the app's executable path, to find its CoreAudio process objects.
  appPath: string;
  // Typeless: the macOS keycode posted with Right Control, matching its Dictate
  // shortcut (F19, a combo no keyboard sends, so the physical Right Ctrl+J stays free).
  key?: number;
  // Wispr Flow reads its shortcuts from the physical keyboard over IOHID and ignores
  // posted keystrokes, so it is driven by its own deep links instead.
  startUrl?: string;
  stopUrl?: string;
};

const ENGINES: Record<Engine["name"], Engine> = {
  typeless: { name: "typeless", label: "Typeless", appPath: "/Typeless.app/", key: 80 },
  wispr: {
    name: "wispr", label: "Wispr Flow", appPath: "/Wispr Flow.app/",
    startUrl: "wispr-flow://start-hands-free", stopUrl: "wispr-flow://stop-hands-free",
  },
};

export function engine(): Engine {
  try {
    if (readFileSync(ENGINE_FILE, "utf8").trim() === "wispr") return ENGINES.wispr;
  } catch {}
  return ENGINES.typeless;
}

if (import.meta.main) {
  const want = process.argv[2];
  if (want) {
    if (want !== "typeless" && want !== "wispr") throw new Error(`engine must be typeless or wispr, got ${want}`);
    mkdirSync(ENGINE_FILE.slice(0, ENGINE_FILE.lastIndexOf("/")), { recursive: true });
    writeFileSync(ENGINE_FILE, `${want}\n`);
  }
  console.log(engine().name);
}
