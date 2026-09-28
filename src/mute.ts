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
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { log, MUTE_SOCKET } from "./dictate.ts";

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
const msgRetInt = dlopen(lib, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 } }).symbols.objc_msgSend;
const msgPtrInt =dlopen(lib, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr } }).symbols.objc_msgSend;
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
  AudioObjectSetPropertyData: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
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

// CoreAudio process objects that belong to Typeless.
function typelessProcesses(): number[] {
  const processes = readU32s(SYSTEM_OBJECT, "prs#");
  for (const key of isTypeless.keys()) if (!processes.includes(key)) isTypeless.delete(key);
  return processes.filter(belongsToTypeless);
}

// Typeless records from its helper process; its input runs only while dictating.
export function typelessRecording(): boolean {
  return typelessProcesses().some((p) => readU32s(p, "piri")[0] === 1);
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

// A global process tap whose mute behaviour is "muted" silences every process's
// output while an aggregate device holding it runs. All of it is private to this
// process, and CoreAudio tears it down if this process dies.
// Typeless restarts its microphone whenever audio devices appear, disappear, start
// or stop, so doing any of that mid-dictation flapped the mute and made Typeless
// drop stop taps. So the tap and a running aggregate are set up once at launch,
// unmuted, and muting only flips the tap's mute behaviour in place.
const CA_TAP_UNMUTED = 0, CA_TAP_MUTED = 1;
type Tap = { tap: number; device: number; ioProc: Pointer };
let setup: Tap | null = null;
let muted = false;

function createTap(): string | null {
  if (setup) return null;
  const description = msgPtr(objc.objc_msgSend(cls("CATapDescription"), sel("alloc")), sel("initStereoGlobalTapButExcludeProcesses:"), objc.objc_msgSend(cls("NSArray"), sel("array")))!;
  msgInt(description, sel("setMuteBehavior:"), CA_TAP_UNMUTED);
  msgInt(description, sel("setPrivate:"), 1);
  const tapUid = nsString(objc.objc_msgSend(objc.objc_msgSend(description, sel("UUID"))!, sel("UUIDString")));
  const tapId = new Uint32Array(1);
  let status = CA.AudioHardwareCreateProcessTap(description, ptr(tapId));
  objc.objc_msgSend(description, sel("release"));
  if (status) return `create tap: ${status}`;

  // The aggregate holds only the tap. Adding the output device as a subdevice also
  // opens that device's input, which is often Typeless's microphone.
  const deviceId = new Uint32Array(1);
  status = CA.AudioHardwareCreateAggregateDevice(nsObjectFromJson({
    uid: `com.lifeos.typelessmute.${process.pid}.${Date.now()}`,
    name: "TypelessMute",
    private: 1,
    stacked: 0,
    tapautostart: 1,
    taps: [{ uid: tapUid, drift: 1 }],
  }), ptr(deviceId));
  if (status) { CA.AudioHardwareDestroyProcessTap(tapId[0]); return `create aggregate: ${status}`; }

  const procId = new BigUint64Array(1);
  status = CA.AudioDeviceCreateIOProcID(deviceId[0], NOOP_IOPROC, null, ptr(procId));
  const ioProc = Number(procId[0]) as Pointer;
  if (!status) status = CA.AudioDeviceStart(deviceId[0], ioProc);
  setup = { tap: tapId[0], device: deviceId[0], ioProc };
  if (status) { destroyTap(); return `start: ${status}`; }
  return null;
}

function destroyTap() {
  if (!setup) return;
  const { tap, device, ioProc } = setup;
  setup = null;
  muted = false;
  if (ioProc) { CA.AudioDeviceStop(device, ioProc); CA.AudioDeviceDestroyIOProcID(device, ioProc); }
  CA.AudioHardwareDestroyAggregateDevice(device);
  CA.AudioHardwareDestroyProcessTap(tap);
}

// Reads the live tap's description, changes its mute behaviour, and writes it back.
function setMuteBehavior(behavior: number): string | null {
  const address = new Uint32Array([fourCC("tdsc"), fourCC("glob"), 0]);
  const size = new Uint32Array([8]);
  const out = new BigUint64Array(1);
  let status = CA.AudioObjectGetPropertyData(setup!.tap, ptr(address), 0, null, ptr(size), ptr(out));
  if (status || !out[0]) return `read tap: ${status}`;
  const description = Number(out[0]) as Pointer;
  msgInt(description, sel("setMuteBehavior:"), behavior);
  // Typeless's own audio stays out of the tap: muting its output made it restart
  // its microphone mid-dictation and drop stop taps.
  msgPtr(description, sel("setProcesses:"), nsObjectFromJson(typelessProcesses()));
  // Not released: CoreAudio's ownership of the returned description is not
  // documented, and releasing it crashed. A few bytes per dictation.
  status = CA.AudioObjectSetPropertyData(setup!.tap, ptr(address), 0, null, 8, ptr(out));
  return status ? `set tap: ${status}` : null;
}

// The live tap's mute behaviour as CoreAudio reports it, for the test mode's log line.
function currentMuteBehavior(): number {
  if (!setup) return -1;
  const address = new Uint32Array([fourCC("tdsc"), fourCC("glob"), 0]);
  const size = new Uint32Array([8]);
  const out = new BigUint64Array(1);
  if (CA.AudioObjectGetPropertyData(setup.tap, ptr(address), 0, null, ptr(size), ptr(out)) || !out[0]) return -1;
  return Number(msgRetInt(Number(out[0]) as Pointer, sel("isMuted")));
}

export function muteAll(): string | null {
  if (muted) return null;
  const error = createTap() ?? setMuteBehavior(CA_TAP_MUTED);
  if (error) return error;
  muted = true;
  return null;
}

export function unmuteAll() {
  if (!muted || !setup) return;
  setMuteBehavior(CA_TAP_UNMUTED);
  muted = false;
}

// Any CoreAudio change while Typeless records (even flipping this tap's mute) makes
// it restart its microphone, and a stop tap that lands during the restart is lost.
// So the mute is flipped on the pedal or keyboard press, before Typeless opens its
// mic, and lifted once that recording ends. A dictation started any other way
// (Typeless's own shortcut) is left unmuted rather than disturbed.
const NO_RECORDING_MS = 3000; // a press that starts nothing is un-muted after this

export function startMuteWatcher(source: string) {
  process.on("exit", destroyTap);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
  const error = createTap(); // up front, so no device appears later
  if (error) log(`${source} tap setup failed, will retry on first dictation: ${error}`);

  let mutedAt = 0, sawRecording = false;
  // One line per press from src/dictate.ts; the reply lets the press go ahead.
  mkdirSync(dirname(MUTE_SOCKET), { recursive: true });
  rmSync(MUTE_SOCKET, { force: true });
  Bun.listen({
    unix: MUTE_SOCKET,
    socket: {
      data(sock) {
        // A press while Typeless records is a stop tap: nothing to do.
        if (!muted && muteSettingOn() && !typelessRecording()) {
          const error = muteAll();
          mutedAt = Date.now();
          sawRecording = false;
          log(error ? `${source} mute failed: ${error}` : `${source} press: muted background audio`);
        }
        sock.write("ok\n");
        sock.end();
      },
    },
  });
  chmodSync(MUTE_SOCKET, 0o600);

  // Typeless's mic can drop for a moment early in a recording; only a gap longer
  // than RECORDING_GAP_MS counts as the recording ending.
  const RECORDING_GAP_MS = 600;
  let lastRecordingAt = 0;
  setInterval(() => {
    if (!muted) return;
    if (typelessRecording()) { sawRecording = true; lastRecordingAt = Date.now(); return; }
    if (sawRecording ? Date.now() - lastRecordingAt > RECORDING_GAP_MS : Date.now() - mutedAt > NO_RECORDING_MS) {
      unmuteAll();
      log(`${source} ${sawRecording ? "recording ended" : "no recording started"}: unmuted`);
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
    log(error ? `mute test failed: ${error}` : `mute test: muted for ${ms}ms (tap mute behaviour ${currentMuteBehavior()})`);
    if (!error) await Bun.sleep(ms);
    unmuteAll();
    log(`mute test: unmuted (tap mute behaviour ${currentMuteBehavior()})`);
    destroyTap();
    process.exit(error ? 1 : 0);
  }
  startMuteWatcher("mute app");
}
