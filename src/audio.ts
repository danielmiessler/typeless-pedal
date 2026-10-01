// Read-only question to CoreAudio: is Typeless's microphone input running right now?
// Used only to time how long Typeless takes to open the mic after a start tap.
// Nothing here changes audio state.
import { dlopen, FFIType, ptr } from "bun:ffi";

const CA = dlopen("/System/Library/Frameworks/CoreAudio.framework/CoreAudio", {
  AudioObjectGetPropertyDataSize: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioObjectGetPropertyData: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;
const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;

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

// CoreAudio process objects are stable for a process's lifetime, so each path is
// resolved once and forgotten when the process goes away.
const processPath = new Map<number, string>();
function audioProcesses(): { object: number; path: string }[] {
  const objects = readU32s(SYSTEM_OBJECT, "prs#");
  for (const key of processPath.keys()) if (!objects.includes(key)) processPath.delete(key);
  return objects.map((object) => {
    let path = processPath.get(object);
    if (path === undefined) {
      const pid = readU32s(object, "ppid")[0];
      const buf = Buffer.alloc(4096);
      const n = pid ? libc.proc_pidpath(pid, ptr(buf), buf.length) : 0;
      path = n > 0 ? buf.toString("utf8", 0, n) : "";
      processPath.set(object, path);
    }
    return { object, path };
  });
}

// Typeless and Wispr Flow record from helper processes inside their app bundles; their
// input runs only while dictating. appPath is a fragment of the bundle path.
export function appRecording(appPath: string): boolean {
  return audioProcesses().some((p) => p.path.includes(appPath) && readU32s(p.object, "piri")[0] === 1);
}

if (import.meta.main) {
  console.log(`typeless recording: ${appRecording("/Typeless.app/")}`);
  console.log(`wispr recording: ${appRecording("/Wispr Flow.app/")}`);
}
