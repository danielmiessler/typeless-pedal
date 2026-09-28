// Read-only questions to CoreAudio about who is using audio: is Typeless recording,
// and is a media app playing. Nothing here changes audio state; changing it (a
// CoreAudio mute tap) made every audio app reinitialise, and was retired.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";

const SETTINGS = `${process.env.HOME}/Library/Application Support/Typeless/app-settings.json`;

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

// Typeless records from its helper process; its input runs only while dictating.
export function typelessRecording(): boolean {
  return audioProcesses().some((p) => p.path.includes("/Typeless.app/") && readU32s(p.object, "piri")[0] === 1);
}

// Apps whose playback the media Play/Pause key controls. Only these trigger a pause,
// so the key never lands on an app that was not playing (a call, a game).
const MEDIA_APP = /\/(Google Chrome|Safari|Firefox|Arc|Brave Browser|Microsoft Edge|Music|Spotify|Podcasts|TV|VLC|IINA|QuickTime Player)\.app\//;

// The media app currently sending audio out, if any.
export function playingMediaApp(): string | null {
  for (const p of audioProcesses()) {
    if (readU32s(p.object, "piro")[0] !== 1) continue;
    const match = p.path.match(MEDIA_APP);
    if (match) return match[1];
  }
  return null;
}

// Typeless's own "Mute audio when dictating" switch, which also turns pausing on and off.
export function muteSettingOn(): boolean {
  try { return JSON.parse(readFileSync(SETTINGS, "utf8")).enabledMuteBackgroundAudio !== false; }
  catch { return true; } // Typeless's own default is on.
}

if (import.meta.main) {
  console.log(`typeless recording: ${typelessRecording()}, playing: ${playingMediaApp() ?? "nothing"}, setting on: ${muteSettingOn()}`);
}
