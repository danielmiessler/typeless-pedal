// Posts a physical-looking Right Control + J keystroke, the Typeless dictation toggle.
// Stream Deck's built-in Hotkey action sends a plain Control flag with no Control
// key event, and Typeless (which tells Left and Right Control apart) ignores it.
// Posting the modifier key itself, with the right-side device flag, fixes that.
import { dlopen, FFIType } from "bun:ffi";

const CG = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGEventSourceCreate: { args: [FFIType.i32], returns: FFIType.ptr },
  CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
  CGEventSetFlags: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
  CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
});
const CF = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
});

const HID_STATE = 1, HID_TAP = 0;
// macOS virtual key codes. Change KEY_LETTER to match your Typeless shortcut.
const KEY_RIGHT_CTRL = 62, KEY_LETTER = 38; // 38 = J
const FLAG_CTRL = 0x40000n, FLAG_RIGHT_CTRL_DEVICE = 0x2000n;
const held = FLAG_CTRL | FLAG_RIGHT_CTRL_DEVICE;

const src = CG.symbols.CGEventSourceCreate(HID_STATE);
function post(code: number, down: boolean, flags: bigint) {
  const e = CG.symbols.CGEventCreateKeyboardEvent(src, code, down);
  CG.symbols.CGEventSetFlags(e, flags);
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
