#if os(macOS)
import AppKit
import Testing

extension UIFnHostedWindowTests {
    /// ``UIFnHostedWindowTests/Window/press(_:)`` delivers a whole press, once
    /// each event, whether the view under it tracks the mouse inside its
    /// mouse-down, as the system switch does, or takes each event as the window
    /// sends it.
    ///
    /// Each test shows a key window and sends it mouse events, so the suite runs
    /// inside ``UIFnHostedWindowTests``, one test at a time.
    @MainActor @Suite
    struct UIFnHostedEventTests {
        /// A view that records the mouse events the window sends it.
        private class Recorder: NSView {
            var sent: [NSEvent.EventType] = []
            var tracked: [NSEvent.EventType] = []

            // The test process is never the active app, so its windows take
            // their first click, as the hosting views in the other suites do.
            override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
            override func mouseDown(with event: NSEvent) { sent.append(event.type) }
            override func mouseDragged(with event: NSEvent) { sent.append(event.type) }
            override func mouseUp(with event: NSEvent) { sent.append(event.type) }
        }

        /// A view that, like `NSControl`, takes the rest of a press inside its
        /// mouse-down through its window's `trackEvents`. A control waits for
        /// the mouse-up with no limit; this one gives up after two seconds, so
        /// a press it never gets fails the test instead of stopping the run.
        private final class Tracker: Recorder {
            override func mouseDown(with event: NSEvent) {
                super.mouseDown(with: event)
                window?.trackEvents(matching: [.leftMouseDragged, .leftMouseUp], timeout: 2, mode: .eventTracking) { next, stop in
                    guard let next else {
                        stop.pointee = true
                        return
                    }
                    self.tracked.append(next.type)
                    if next.type == .leftMouseUp { stop.pointee = true }
                }
            }
        }

        /// The same, through its window's `nextEvent`, as a text view does.
        private final class Poller: Recorder {
            override func mouseDown(with event: NSEvent) {
                super.mouseDown(with: event)
                while let next = window?.nextEvent(
                    matching: [.leftMouseDragged, .leftMouseUp],
                    until: Date(timeIntervalSinceNow: 2),
                    inMode: .eventTracking,
                    dequeue: true
                ) {
                    tracked.append(next.type)
                    if next.type == .leftMouseUp { break }
                }
            }
        }

        /// Sends a press across a window showing the view: a mouse-down, eight
        /// drags and a mouse-up. Returns the types of the events sent.
        private func press(_ view: Recorder) throws -> [NSEvent.EventType] {
            let window = UIFnHostedWindowTests.Window(width: 200, height: 100)
            defer { window.close() }
            window.contentView = view
            window.makeKeyAndOrderFront(nil)
            let points = (0...9).map { NSPoint(x: 40 + CGFloat($0) * 10, y: 50) }
            let events = try [UIFnHostedWindowTests.mouseEvent(.leftMouseDown, at: points[0], in: window)]
                + points.dropFirst().dropLast().map { try UIFnHostedWindowTests.mouseEvent(.leftMouseDragged, at: $0, in: window) }
                + [UIFnHostedWindowTests.mouseEvent(.leftMouseUp, at: points[9], in: window)]
            let started = ProcessInfo.processInfo.systemUptime
            window.press(events)
            // A view left waiting for the rest gives up only after two seconds.
            #expect(ProcessInfo.processInfo.systemUptime - started < 1)
            return events.map(\.type)
        }

        @Test
        func aViewThatTracksThePressGetsAllOfItInItsMouseDown() throws {
            for view in [Tracker(), Poller()] {
                let types = try press(view)
                #expect(view.tracked == Array(types.dropFirst()), "\(type(of: view))")
                // The events the mouse-down took are not sent again.
                #expect(view.sent == [.leftMouseDown], "\(type(of: view))")
            }
        }

        @Test
        func aViewThatDoesNotTrackGetsEachEventOnceInOrder() throws {
            let view = Recorder()
            let types = try press(view)
            #expect(view.sent == types)
            #expect(view.tracked.isEmpty)
        }
    }
}
#endif
