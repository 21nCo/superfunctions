# RecFn Desktop SDK for macOS

This folder contains the macOS-specific desktop notetaker implementation used by the
Meeting Recording POC.

The SDK owns the native desktop approach:

- detects active Google Meet and Zoom meetings across browser tabs/windows
- requests/checks macOS microphone, screen recording, and browser automation permissions
- captures system audio with ScreenCaptureKit
- captures microphone audio with AVAudioEngine
- transcribes local audio with whisper.cpp
- emits transcript lines, meeting status, SDK logs, and simple notes

The POC app in `21n/poc` should stay a thin demo/client. Its Xcode project links this
SDK source from `super-functions.next/recfn/desktop/macos/Sources/RecFnDesktopSDK`
instead of keeping the desktop implementation inside the POC repo.

