/*
 * noVNC-iKVM: USB HID keyboard usage tables
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * ATEN iKVM (and other BMC KVMs) emulate a USB keyboard, so they expect
 * HID usage IDs (USB HID Usage Tables, page 0x07) rather than X11 keysyms.
 */

import KeyTable from "./keysym.js";

// KeyboardEvent.code -> HID usage. Physical keys, independent of the
// local keyboard layout; the remote OS applies its own layout.
export const codeToHID = {
    "KeyA": 0x04, "KeyB": 0x05, "KeyC": 0x06, "KeyD": 0x07, "KeyE": 0x08,
    "KeyF": 0x09, "KeyG": 0x0a, "KeyH": 0x0b, "KeyI": 0x0c, "KeyJ": 0x0d,
    "KeyK": 0x0e, "KeyL": 0x0f, "KeyM": 0x10, "KeyN": 0x11, "KeyO": 0x12,
    "KeyP": 0x13, "KeyQ": 0x14, "KeyR": 0x15, "KeyS": 0x16, "KeyT": 0x17,
    "KeyU": 0x18, "KeyV": 0x19, "KeyW": 0x1a, "KeyX": 0x1b, "KeyY": 0x1c,
    "KeyZ": 0x1d,

    "Digit1": 0x1e, "Digit2": 0x1f, "Digit3": 0x20, "Digit4": 0x21,
    "Digit5": 0x22, "Digit6": 0x23, "Digit7": 0x24, "Digit8": 0x25,
    "Digit9": 0x26, "Digit0": 0x27,

    "Enter": 0x28, "Escape": 0x29, "Backspace": 0x2a, "Tab": 0x2b,
    "Space": 0x2c, "Minus": 0x2d, "Equal": 0x2e, "BracketLeft": 0x2f,
    "BracketRight": 0x30, "Backslash": 0x31, "IntlHash": 0x32,
    "Semicolon": 0x33, "Quote": 0x34, "Backquote": 0x35, "Comma": 0x36,
    "Period": 0x37, "Slash": 0x38, "CapsLock": 0x39,

    "F1": 0x3a, "F2": 0x3b, "F3": 0x3c, "F4": 0x3d, "F5": 0x3e, "F6": 0x3f,
    "F7": 0x40, "F8": 0x41, "F9": 0x42, "F10": 0x43, "F11": 0x44, "F12": 0x45,

    "PrintScreen": 0x46, "ScrollLock": 0x47, "Pause": 0x48, "Insert": 0x49,
    "Home": 0x4a, "PageUp": 0x4b, "Delete": 0x4c, "End": 0x4d,
    "PageDown": 0x4e, "ArrowRight": 0x4f, "ArrowLeft": 0x50,
    "ArrowDown": 0x51, "ArrowUp": 0x52,

    "NumLock": 0x53, "NumpadDivide": 0x54, "NumpadMultiply": 0x55,
    "NumpadSubtract": 0x56, "NumpadAdd": 0x57, "NumpadEnter": 0x58,
    "Numpad1": 0x59, "Numpad2": 0x5a, "Numpad3": 0x5b, "Numpad4": 0x5c,
    "Numpad5": 0x5d, "Numpad6": 0x5e, "Numpad7": 0x5f, "Numpad8": 0x60,
    "Numpad9": 0x61, "Numpad0": 0x62, "NumpadDecimal": 0x63,

    "IntlBackslash": 0x64, "ContextMenu": 0x65, "Power": 0x66,
    "NumpadEqual": 0x67,

    "F13": 0x68, "F14": 0x69, "F15": 0x6a, "F16": 0x6b, "F17": 0x6c,
    "F18": 0x6d, "F19": 0x6e, "F20": 0x6f, "F21": 0x70, "F22": 0x71,
    "F23": 0x72, "F24": 0x73,

    "Help": 0x75, "Undo": 0x7a, "Cut": 0x7b, "Copy": 0x7c, "Paste": 0x7d,
    "Find": 0x7e, "AudioVolumeMute": 0x7f, "AudioVolumeUp": 0x80,
    "AudioVolumeDown": 0x81, "NumpadComma": 0x85, "IntlRo": 0x87,
    "KanaMode": 0x88, "IntlYen": 0x89, "Convert": 0x8a, "NonConvert": 0x8b,
    "Lang1": 0x90, "Lang2": 0x91,

    "ControlLeft": 0xe0, "ShiftLeft": 0xe1, "AltLeft": 0xe2, "MetaLeft": 0xe3,
    "ControlRight": 0xe4, "ShiftRight": 0xe5, "AltRight": 0xe6,
    "MetaRight": 0xe7,
    // Legacy names used by older browsers
    "OSLeft": 0xe3, "OSRight": 0xe7,
};

export const HID_LEFT_SHIFT = 0xe1;

// Printable ASCII -> { hid, shift } for a US keyboard layout. Used when
// we only have a character (pasted text) and must synthesize keystrokes.
const usChars = {};
(() => {
    const plain = "abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < plain.length; i++) {
        usChars[plain[i]] = { hid: 0x04 + i, shift: false };
        usChars[plain[i].toUpperCase()] = { hid: 0x04 + i, shift: true };
    }
    const digits = "1234567890";
    const shifted = "!@#$%^&*()";
    for (let i = 0; i < digits.length; i++) {
        usChars[digits[i]] = { hid: 0x1e + i, shift: false };
        usChars[shifted[i]] = { hid: 0x1e + i, shift: true };
    }
    const pairs = [
        [" ", " ", 0x2c],
        ["-", "_", 0x2d], ["=", "+", 0x2e], ["[", "{", 0x2f], ["]", "}", 0x30],
        ["\\", "|", 0x31], [";", ":", 0x33], ["'", "\"", 0x34], ["`", "~", 0x35],
        [",", "<", 0x36], [".", ">", 0x37], ["/", "?", 0x38],
    ];
    for (const [lo, hi, hid] of pairs) {
        usChars[lo] = { hid, shift: false };
        if (hi !== lo) usChars[hi] = { hid, shift: true };
    }
    usChars["\n"] = { hid: 0x28, shift: false };
    usChars["\r"] = { hid: 0x28, shift: false };
    usChars["\t"] = { hid: 0x2b, shift: false };
})();

// Character -> { hid, shift } on a US layout, or null if not typeable.
export function charToHID(ch) {
    return usChars[ch] || null;
}

// Non-printable keysyms -> HID usage
const keysymSpecial = {
    [KeyTable.XK_BackSpace]: 0x2a, [KeyTable.XK_Tab]: 0x2b,
    0xfe20 /* XK_ISO_Left_Tab */: 0x2b,
    [KeyTable.XK_Return]: 0x28, [KeyTable.XK_Escape]: 0x29,
    [KeyTable.XK_Delete]: 0x4c, [KeyTable.XK_Insert]: 0x49,
    [KeyTable.XK_Home]: 0x4a, [KeyTable.XK_End]: 0x4d,
    [KeyTable.XK_Page_Up]: 0x4b, [KeyTable.XK_Page_Down]: 0x4e,
    [KeyTable.XK_Left]: 0x50, [KeyTable.XK_Up]: 0x52,
    [KeyTable.XK_Right]: 0x4f, [KeyTable.XK_Down]: 0x51,
    [KeyTable.XK_Print]: 0x46, [KeyTable.XK_Sys_Req]: 0x46,
    [KeyTable.XK_Scroll_Lock]: 0x47, [KeyTable.XK_Pause]: 0x48,
    [KeyTable.XK_Break]: 0x48, [KeyTable.XK_Menu]: 0x65,
    [KeyTable.XK_Caps_Lock]: 0x39, [KeyTable.XK_Num_Lock]: 0x53,
    [KeyTable.XK_Shift_L]: 0xe1, [KeyTable.XK_Shift_R]: 0xe5,
    [KeyTable.XK_Control_L]: 0xe0, [KeyTable.XK_Control_R]: 0xe4,
    [KeyTable.XK_Alt_L]: 0xe2, [KeyTable.XK_Alt_R]: 0xe6,
    [KeyTable.XK_Meta_L]: 0xe3, [KeyTable.XK_Meta_R]: 0xe7,
    [KeyTable.XK_Super_L]: 0xe3, [KeyTable.XK_Super_R]: 0xe7,
    [KeyTable.XK_ISO_Level3_Shift]: 0xe6,
    [KeyTable.XK_KP_Enter]: 0x58, [KeyTable.XK_KP_Divide]: 0x54,
    [KeyTable.XK_KP_Multiply]: 0x55, [KeyTable.XK_KP_Subtract]: 0x56,
    [KeyTable.XK_KP_Add]: 0x57, [KeyTable.XK_KP_Decimal]: 0x63,
    [KeyTable.XK_KP_Delete]: 0x63, [KeyTable.XK_KP_Insert]: 0x62,
    [KeyTable.XK_KP_0]: 0x62,
};
for (let i = 0; i < 9; i++) {
    keysymSpecial[KeyTable.XK_KP_1 + i] = 0x59 + i;
}
for (let i = 0; i < 12; i++) {
    keysymSpecial[KeyTable.XK_F1 + i] = 0x3a + i;
}
for (let i = 0; i < 12; i++) {
    keysymSpecial[KeyTable.XK_F13 + i] = 0x68 + i;
}

// keysym -> HID usage, ignoring shift state. Used when no physical key
// code is available (e.g. keys sent from the toolbar).
export function keysymToHID(keysym) {
    if (keysym in keysymSpecial) {
        return keysymSpecial[keysym];
    }
    if (keysym >= 0x20 && keysym <= 0x7e) {
        const m = usChars[String.fromCharCode(keysym)];
        return m ? m.hid : null;
    }
    return null;
}

// Pick the HID usage for a key event: the physical key if known,
// otherwise derive it from the keysym.
export function keyEventToHID(keysym, code) {
    if (code && code in codeToHID) {
        return codeToHID[code];
    }
    return keysymToHID(keysym);
}
