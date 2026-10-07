#!/usr/bin/env swift
// BUG-081 regression probe: NSMenuItem.description must not trap on the Host
// menu's Thai titles.
//
//   swift scripts/probe-menu-titles.swift   (npm run test:menutitle)
//
// Background: a Swift-native (UTF-8-backed) non-ASCII title traps in
// -[NSMenuItem _description:] → __StringStorage.getCharacters → SIGTRAP, and
// AppKit formats that description on every menu highlight via
// _NSNoteInCrashReports — merely opening the Host menu crashed the app.
// The shell routes every Host title through NSString (Foundation-owned
// storage), which takes the safe path. This probe exercises the exact
// crashing call on the exact shipping titles; a trap fails the run.
import AppKit

// Must mirror AppDelegate.installHostMenu titles in
// macos/MuseDesktopShell/Sources/MuseDesktopShell/MuseDesktopShellApp.swift.
let titles = [
    "Host",
    "เปิด log ของ host",
    "เปิดโฟลเดอร์ state",
    "รีสตาร์ท host",
    "หยุด host + agents",
]

var failed = false
for t in titles {
    let item = NSMenuItem(title: NSString(string: t) as String, action: nil, keyEquivalent: "")
    let d = item.description
    if !d.isEmpty && item.title == t {
        print("ok   menu title survives description: \(t)")
    } else {
        failed = true
        print("FAIL menu title broken in description: \(t)")
    }
}
if failed { exit(1) }
print("menu-titles: \(titles.count)/\(titles.count) passed")
