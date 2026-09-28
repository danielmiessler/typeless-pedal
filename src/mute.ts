// Mutes background audio while Typeless is recording, when Typeless's own
// "Mute audio when dictating" setting is on.
// Typeless mutes by muting the system output device. Some devices have no mute or
// volume control (virtual and pro-audio outputs, e.g. Merging's MT VAD), so its
// mute silently does nothing there. This mutes every app's audio with a CoreAudio
// process tap instead (macOS 14.2+), which works on any output device.
// A tap only silences audio while it is running inside an aggregate device, and
// only for a process macOS lets record system audio. So this runs as its own small
// app (TypelessMute.app, built by install.ts) that carries that permission.
// It follows Typeless's recording state, not key presses, so it is right for taps,
// holds, and dictations Typeless ends on its own.
import { dlopen, FFIType, ptr, CString, type Pointer } from "bun:ffi";
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
const msgPtrInt = dlopen(lib, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr } }).symbols.objc_msgSend;
const msgJson = dlopen(lib, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend;
// CATapDescription lives in CoreAudio but needs Foundation loaded.
dlopen("/System/Library/Frameworks/Foundation.framework/Foundation", { NSLog: { args: [FFIType.ptr], returns: FFIType.void } });
const CA = dlopen("/System/Library/Frameworks/CoreAudio.framework/CoreAudio", {
  AudioHardwareCreateProcessTap: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioHardwareDestroyProcessTap: { args: [FFIType.u32], returns: FFIType.i32 },
  AudioHardwareCreateAggregateDevice: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioHardwareDestroyAggregateDevice: { args: [FFIType.u32], returns: FFIType.i32 },
  AudioDeviceCreateIOProcID: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioDeviceDestroyIOProcID: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AudioDeviceStart: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AudioDeviceStop: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AudioObjectGetPropertyDataSize: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioObjectGetPropertyData: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;
const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  dlsym: { args: [FFIType.i64, FFIType.cstring], returns: FFIType.ptr },
}).symbols;

const cstr = (s: string) => Buffer.from(s + "\0");
const sel = (name: string) => objc.sel_registerName(cstr(name));
const cls = (name: string) => objc.objc_getClass(cstr(name));
const fourCC = (s: string) => [...s].reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;
const nsString = (s: Pointer | null) => (s ? new CString(objc.objc_msgSend(s, sel("UTF8String"))!).toString() : "");

// The aggregate device's IO callback only has to exist; the tap mutes while IO runs.
// getpid ignores its arguments and has no side effects, and CoreAudio ignores the
// callback's return value, so it stands in for a no-op callback.
const RTLD_DEFAULT = -2;
const NOOP_IOPROC = libc.dlsym(RTLD_DEFAULT, cstr("getpid"));

const SYSTEM_OBJECT = 1;
const addressOf = (selector: string) => new Uint32Array([fourCC(selector), fourCC("glob"), 0]);
function readU32s(object: number, selector: string): number[] {
  const address = addressOf(selector);
  const size = new Uint32Array(1);
  if (CA.AudioObjectGetPropertyDataSize(object, ptr(address), 0, null, ptr(size)) || !size[0]) return [];
  const out = new Uint32Array(size[0] / 4);
  if (CA.AudioObjectGetPropertyData(object, ptr(address), 0, null, ptr(size), ptr(out))) return [];
  return [...out.subarray(0, size[0] / 4)];
}
function readString(object: number, selector: string): string {
  const size = new Uint32Array([8]);
  const out = new BigUint64Array(1);
  if (CA.AudioObjectGetPropertyData(object, ptr(addressOf(selector)), 0, null, ptr(size), ptr(out)) || !out[0]) return "";
  const s = nsString(Number(out[0]) as Pointer);
  objc.objc_msgSend(Number(out[0]) as Pointer, sel("release"));
  return s;
}

// CoreAudio process objects are stable for a process's lifetime, so each is resolved once.
const isTypeless = new Map<number, boolean>();
function belongsToTypeless(processObject: number): boolean {
  let known = isTypeless.get(processObject);
  if (known === undefined) {
    const pid = readU32s(processObject, "ppid")[0];
    const path = Buffer.alloc(4096);
    const n = pid ? libc.proc_pidpath(pid, ptr(path), path.length) : 0;
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

function nsObjectFromJson(value: unknown): Pointer {
  const bytes = Buffer.from(JSON.stringify(value));
  const data = msgPtrInt(cls("NSData"), sel("dataWithBytes:length:"), ptr(bytes), bytes.length);
  return msgJson(cls("NSJSONSerialization"), sel("JSONObjectWithData:options:error:"), data, 0, null)!;
}

// A global tap with the "muted" behaviour silences every process's output while an
// aggregate device containing it is running. All of it is private to this process,
// and CoreAudio tears it down if this process dies.
const CA_TAP_MUTED = 1;
type Mute = { tap: number; device: number; ioProc: Pointer };
let active: Mute | null = null;

export function muteAll(): string | null {
  if (active) return null;
  const description = msgPtr(objc.objc_msgSend(cls("CATapDescription"), sel("alloc")), sel("initStereoGlobalTapButExcludeProcesses:"), objc.objc_msgSend(cls("NSArray"), sel("array")))!;
  msgInt(description, sel("setMuteBehavior:"), CA_TAP_MUTED);
  msgInt(description, sel("setPrivate:"), 1);
  const tapUid = nsString(objc.objc_msgSend(objc.objc_msgSend(description, sel("UUID"))!, sel("UUIDString")));
  const tapId = new Uint32Array(1);
  let status = CA.AudioHardwareCreateProcessTap(description, ptr(tapId));
  objc.objc_msgSend(description, sel("release"));
  if (status) return `create tap: ${status}`;

  const outputUid = readString(readU32s(SYSTEM_OBJECT, "dOut")[0] ?? 0, "uid ");
  const deviceId = new Uint32Array(1);
  status = CA.AudioHardwareCreateAggregateDevice(nsObjectFromJson({
    uid: `com.lifeos.typelessmute.${process.pid}.${Date.now()}`,
    name: "TypelessMute",
    private: 1,
    stacked: 0,
    tapautostart: 1,
    ...(outputUid ? { master: outputUid, subdevices: [{ uid: outputUid }] } : {}),
    taps: [{ uid: tapUid, drift: 1 }],
  }), ptr(deviceId));
  if (status) { CA.AudioHardwareDestroyProcessTap(tapId[0]); return `create aggregate: ${status}`; }

  const procId = new BigUint64Array(1);
  status = CA.AudioDeviceCreateIOProcID(deviceId[0], NOOP_IOPROC, null, ptr(procId));
  const ioProc = Number(procId[0]) as Pointer;
  if (!status) status = CA.AudioDeviceStart(deviceId[0], ioProc);
  active = { tap: tapId[0], device: deviceId[0], ioProc };
  if (status) { unmuteAll(); return `start: ${status}`; }
  return null;
}

export function unmuteAll() {
  if (!active) return;
  const { tap, device, ioProc } = active;
  active = null;
  if (ioProc) { CA.AudioDeviceStop(device, ioProc); CA.AudioDeviceDestroyIOProcID(device, ioProc); }
  CA.AudioHardwareDestroyAggregateDevice(device);
  CA.AudioHardwareDestroyProcessTap(tap);
}

export function startMuteWatcher(source: string) {
  process.on("exit", unmuteAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
  setInterval(() => {
    const recording = typelessRecording();
    if (recording && !active && muteSettingOn()) {
      const error = muteAll();
      log(error ? `${source} mute failed: ${error}` : `${source} recording: muted background audio`);
    } else if (!recording && active) {
      unmuteAll();
      log(`${source} stopped: unmuted`);
    }
  }, POLL_MS);
  log(`${source} started`);
}

if (import.meta.main) {
  // `mute --test [ms]` mutes everything for ms (default 3000), to check by ear.
  // With no arguments it runs the watcher.
  if (process.argv.includes("--test")) {
    const ms = Number(process.argv[process.argv.indexOf("--test") + 1]) || 3000;
    const error = muteAll();
    log(error ? `mute test failed: ${error}` : `mute test: muted for ${ms}ms`);
    if (!error) await Bun.sleep(ms);
    unmuteAll();
    process.exit(error ? 1 : 0);
  }
  startMuteWatcher("mute app");
}
