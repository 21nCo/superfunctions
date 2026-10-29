#if os(macOS)
import Testing

/// The suites that show a key window and send it events or wait for focus.
/// Only one window can be key, so every test in them runs one at a time,
/// across suites as well as within each.
@MainActor @Suite(.serialized)
struct UIFnHostedWindowTests {}
#endif
