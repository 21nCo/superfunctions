#if os(macOS)
import AppKit
import Testing

/// The suites that show a key window and send it events or wait for focus.
/// Only one window can be key, so every test in them runs one at a time,
/// across suites as well as within each.
@MainActor @Suite(.serialized)
struct UIFnHostedWindowTests {
    /// A left-button mouse event at a point in the window's coordinates.
    static func mouseEvent(_ type: NSEvent.EventType, at point: NSPoint, in window: NSWindow) throws -> NSEvent {
        try #require(NSEvent.mouseEvent(
            with: type,
            location: point,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: type == .leftMouseUp ? 0 : 1
        ))
    }

    /// A window the hosted suites send presses to.
    ///
    /// A control that tracks the mouse itself, like the system switch, asks its
    /// window for the rest of a press inside its mouse-down and waits there
    /// until the mouse-up comes. Sent one by one, the rest would only come after
    /// the mouse-down returns, so the control would wait forever. This window
    /// answers those requests from the press being sent.
    ///
    /// While a press is being sent, the first request after each event that
    /// does not wait gets nothing, as the next event of a real press has not
    /// come yet; asked again, it has. The system switch's drag tracker asks
    /// that way after each drag to skip to the newest one, and if it got the
    /// rest of the press there it would see only the first drag and the
    /// mouse-up, and take a drag out and back for a click. The app's event
    /// queue is not asked then: that stops the test runner too.
    ///
    /// Posting the rest to the app's event queue instead would stop the test
    /// runner: posting an event stops the main run loop, and the runner exits
    /// when its main run loop stops.
    final class Window: NSWindow {
        /// The events of the press being sent that nothing has taken yet.
        private var rest: [NSEvent] = []
        /// Whether a request that did not wait got nothing since the last event
        /// of the press was taken.
        private var polled = false

        convenience init(width: CGFloat, height: CGFloat) {
            self.init(
                contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            isReleasedWhenClosed = false
        }

        /// Sends a press: its mouse-down, then the drags and the mouse-up that
        /// follow it. A view that tracks the mouse takes them inside its
        /// mouse-down; any it does not take are sent after it, in order, so
        /// each event arrives once.
        func press(_ events: [NSEvent]) {
            guard let down = events.first else { return }
            rest = Array(events.dropFirst())
            polled = false
            sendEvent(down)
            while !rest.isEmpty {
                sendEvent(rest.removeFirst())
            }
        }

        /// The next event of the press, if the mask takes it.
        private func next(matching mask: NSEvent.EventTypeMask, dequeue: Bool) -> NSEvent? {
            guard let event = rest.first, mask.contains(NSEvent.EventTypeMask(type: event.type)) else { return nil }
            if dequeue {
                rest.removeFirst()
                polled = false
            }
            return event
        }

        override func nextEvent(
            matching mask: NSEvent.EventTypeMask,
            until expiration: Date?,
            inMode mode: RunLoop.Mode,
            dequeue: Bool
        ) -> NSEvent? {
            if !rest.isEmpty, !polled, !(expiration.map { $0.timeIntervalSinceNow > 0 } ?? false) {
                polled = true
                return nil
            }
            return next(matching: mask, dequeue: dequeue)
                ?? super.nextEvent(matching: mask, until: expiration, inMode: mode, dequeue: dequeue)
        }

        override func trackEvents(
            matching mask: NSEvent.EventTypeMask,
            timeout: TimeInterval,
            mode: RunLoop.Mode,
            handler: (NSEvent?, UnsafeMutablePointer<ObjCBool>) -> Void
        ) {
            var stop: ObjCBool = false
            while !stop.boolValue, let event = next(matching: mask, dequeue: true) {
                handler(event, &stop)
            }
            if !stop.boolValue {
                super.trackEvents(matching: mask, timeout: timeout, mode: mode, handler: handler)
            }
        }
    }
}
#endif
