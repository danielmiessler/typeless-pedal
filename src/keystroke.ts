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

// One tap of Right Ctrl+J: Typeless starts dictation if idle, stops it if recording.
export async function toggleDictation() {
  post(KEY_RIGHT_CTRL, true, held);
  await Bun.sleep(15);
  post(KEY_LETTER, true, held);
  await Bun.sleep(40);
  post(KEY_LETTER, false, held);
  await Bun.sleep(15);
  post(KEY_RIGHT_CTRL, false, 0n);
  await Bun.sleep(20);
}

const KEY_RETURN = 36;

// A plain Return press, used to send what Typeless just pasted.
export async function pressEnter() {
  post(KEY_RETURN, true, 0n);
  await Bun.sleep(30);
  post(KEY_RETURN, false, 0n);
}

if (import.meta.main) await toggleDictation();
