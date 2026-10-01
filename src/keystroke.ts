// Posts a physical-looking Right Control + J keystroke, the Typeless dictation toggle.
// Stream Deck's built-in Hotkey action sends a plain Control flag with no Control
// key event, and Typeless (which tells Left and Right Control apart) ignores it.
// Posting the modifier key itself, with the right-side device flag, fixes that.
import { dlopen, FFIType } from "bun:ffi";

const CG = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGEventSourceCreate: { args: [FFIType.i32], returns: FFIType.ptr },
  CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
  CGEventSetFlags: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
  CGEventSetIntegerValueField: { args: [FFIType.ptr, FFIType.u32, FFIType.i64], returns: FFIType.void },
  CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
});
const CF = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
});

const HID_STATE = 1, HID_TAP = 0;
// macOS virtual key codes. KEY_LETTER must match your Typeless Dictate shortcut.
// It's F19 rather than J because Typeless swallows its shortcut below Hammerspoon;
// with Typeless on Right Ctrl+F19, the physical Right Ctrl+J is free for the
// keyboard adapter to catch (see keyboard/typeless_keys.lua).
const KEY_RIGHT_CTRL = 62, KEY_LETTER = 80; // 80 = F19
const FLAG_CTRL = 0x40000n, FLAG_RIGHT_CTRL_DEVICE = 0x2000n;
const held = FLAG_CTRL | FLAG_RIGHT_CTRL_DEVICE;

// Stamped on every event we post (kCGEventSourceUserData) so the keyboard adapter
// can tell our synthetic Right Ctrl+J from a physical one and let it through.
// Must match SYNTHETIC_MARK in keyboard/typeless-keys.lua.
const EVENT_SOURCE_USER_DATA = 42, SYNTHETIC_MARK = 0x7479706cn; // "typl"

const src = CG.symbols.CGEventSourceCreate(HID_STATE);
function post(code: number, down: boolean, flags: bigint) {
  const e = CG.symbols.CGEventCreateKeyboardEvent(src, code, down);
  CG.symbols.CGEventSetFlags(e, flags);
  CG.symbols.CGEventSetIntegerValueField(e, EVENT_SOURCE_USER_DATA, SYNTHETIC_MARK);
  CG.symbols.CGEventPost(HID_TAP, e);
  CF.symbols.CFRelease(e);
}

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  clock_gettime_nsec_np: { args: [FFIType.i32], returns: FFIType.u64 },
});
// Nanoseconds since boot on the clock Hammerspoon's hs.timer.absoluteTime uses.
const CLOCK_UPTIME_RAW = 8;
export const uptimeNs = (): bigint => BigInt(libc.symbols.clock_gettime_nsec_np(CLOCK_UPTIME_RAW));

// One tap of Right Ctrl+<key>: the dictation app starts if idle, stops if recording.
// key defaults to Typeless's F19; Wispr Flow's hands-free toggle passes its own.
// Typeless acts on the key-down, so the modifier and the key go down back to back:
// CGEventPost delivers in order, and any wait before the key-down is speech lost.
// Returns when the key went down.
export async function toggleDictation(key = KEY_LETTER): Promise<bigint> {
  post(KEY_RIGHT_CTRL, true, held);
  post(key, true, held);
  const downAt = uptimeNs();
  await Bun.sleep(40);
  post(key, false, held);
  post(KEY_RIGHT_CTRL, false, 0n);
  return downAt;
}

const KEY_J = 38;

// Typeless keeps its own list of held keys from an event tap below Hammerspoon, so
// it sees the physical Right Ctrl+J the adapter swallows. While those are down,
// our Right Ctrl+F19 reads as a three-key combo and is ignored. Posting their
// key-ups first clears that list; apps just see a stray key-up. Once J starts
// auto-repeating it re-enters the list, so this only works early in the press.
export function releaseKeyboardShortcut() {
  post(KEY_J, false, 0n);
  post(KEY_RIGHT_CTRL, false, 0n);
}

const KEY_RETURN = 36;

// A plain Return press, used to send what Typeless just pasted.
export async function pressEnter() {
  post(KEY_RETURN, true, 0n);
  await Bun.sleep(30);
  post(KEY_RETURN, false, 0n);
}

if (import.meta.main) await toggleDictation();
