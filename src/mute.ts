// Mutes background audio while Typeless is recording, when Typeless's own
// "Mute audio when dictating" setting is on.
// Typeless mutes by muting the system output device. Some devices have no mute or
// volume control (virtual and pro-audio outputs, e.g. Merging's MT VAD), so its
// mute silently does nothing there. This mutes every app's audio with a CoreAudio
// process tap instead (macOS 14.2+), which works on any output device.
// It follows Typeless's recording state, not key presses, so it is right for taps,
// holds, and dictations Typeless ends on its own.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import { log } from "./dictate.ts";

const POLL_MS = 100;
const SETTINGS = `${process.env.HOME}/Library/Application Support/Typeless/app-settings.json`;

const lib = "/usr/lib/libobjc.A.dylib";
const objc = dlopen(lib, {
  objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols;
// objc_msgSend called with other argument lists.
const msgPtr = dlopen(lib, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend;
const msgInt = dlopen(lib, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.void } }).symbols.objc_msgSend;
// CATapDescription lives in CoreAudio but needs Foundation loaded.
dlopen("/System/Library/Frameworks/Foundation.framework/Foundation", { NSLog: { args: [FFIType.ptr], returns: FFIType.void } });
const CA = dlopen("/System/Library/Frameworks/CoreAudio.framework/CoreAudio", {
  AudioHardwareCreateProcessTap: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioHardwareDestroyProcessTap: { args: [FFIType.u32], returns: FFIType.i32 },
  AudioObjectGetPropertyDataSize: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioObjectGetPropertyData: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;
const libproc = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;

const cstr = (s: string) => Buffer.from(s + "\0");
const sel = (name: string) => objc.sel_registerName(cstr(name));
const fourCC = (s: string) => [...s].reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;

const SYSTEM_OBJECT = 1;
function readU32s(object: number, selector: string): number[] {
  const address = new Uint32Array([fourCC(selector), fourCC("glob"), 0]);
  const size = new Uint32Array(1);
  if (CA.AudioObjectGetPropertyDataSize(object, ptr(address), 0, null, ptr(size)) || !size[0]) return [];
  const out = new Uint32Array(size[0] / 4);
  if (CA.AudioObjectGetPropertyData(object, ptr(address), 0, null, ptr(size), ptr(out))) return [];
  return [...out.subarray(0, size[0] / 4)];
}

// CoreAudio process objects are stable for a process's lifetime, so each is resolved once.
const isTypeless = new Map<number, boolean>();
function belongsToTypeless(processObject: number): boolean {
  let known = isTypeless.get(processObject);
  if (known === undefined) {
    const pid = readU32s(processObject, "ppid")[0];
    const path = Buffer.alloc(4096);
    const n = pid ? libproc.proc_pidpath(pid, ptr(path), path.length) : 0;
    known = n > 0 && path.toString("utf8", 0, n).includes("/Typeless.app/");
    isTypeless.set(processObject, known);
  }
  return known;
}

// Typeless records from its helper process; its input runs only while dictating.
export function typelessRecording(): boolean {
  const processes = readU32s(SYSTEM_OBJECT, "prs#");
  for (const key of isTypeless.keys()) if (!processes.includes(key)) isTypeless.delete(key);
  return processes.some((p) => belongsToTypeless(p) && readU32s(p, "piri")[0] === 1);
}

function muteSettingOn(): boolean {
  try { return JSON.parse(readFileSync(SETTINGS, "utf8")).enabledMuteBackgroundAudio !== false; }
  catch { return true; } // Typeless's own default is on.
}

// A global tap with the "muted" behaviour silences every process's output while it exists.
// It is private to this process, and CoreAudio drops it if this process dies.
const CA_TAP_MUTED = 1;
let tap = 0;

export function muteAll(): boolean {
  if (tap) return true;
  let description = objc.objc_msgSend(objc.objc_getClass(cstr("CATapDescription")), sel("alloc"));
  description = msgPtr(description, sel("initStereoGlobalTapButExcludeProcesses:"), objc.objc_msgSend(objc.objc_getClass(cstr("NSArray")), sel("array")));
  msgInt(description, sel("setMuteBehavior:"), CA_TAP_MUTED);
  msgInt(description, sel("setPrivate:"), 1);
  const id = new Uint32Array(1);
  const status = CA.AudioHardwareCreateProcessTap(description, ptr(id));
  objc.objc_msgSend(description, sel("release"));
  if (status !== 0) { log(`mute failed: CoreAudio status ${status}`); return false; }
  tap = id[0];
  return true;
}

export function unmuteAll() {
  if (!tap) return;
  CA.AudioHardwareDestroyProcessTap(tap);
  tap = 0;
}

export function startMuteWatcher(source: string) {
  process.on("exit", unmuteAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
  setInterval(() => {
    const recording = typelessRecording();
    if (recording && !tap && muteSettingOn()) {
      if (muteAll()) log(`${source} recording: muted background audio`);
    } else if (!recording && tap) {
      unmuteAll();
      log(`${source} stopped: unmuted`);
    }
  }, POLL_MS);
}

if (import.meta.main) {
  // Manual check: `bun src/mute.ts [ms]` mutes everything for ms (default 3000).
  console.log(`typeless recording: ${typelessRecording()}, mute setting: ${muteSettingOn()}`);
  if (muteAll()) { console.log("muted"); await Bun.sleep(Number(process.argv[2] ?? 3000)); }
  unmuteAll();
  console.log("unmuted");
}
