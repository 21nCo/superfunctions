import SwiftUI
import UIFnSwiftUI

// One screen for each UIFn component, showing each tone and layout it has.

struct SegmentedMetersScreen: View {
    var body: some View {
        WorkbenchSection("Tones") {
            UIFnSegmentedMeter("Signal", value: 3.0, in: 0...4, segments: 4, tone: .accent)
            UIFnSegmentedMeter("Health", value: 0.9, segments: 5, tone: .success)
            UIFnSegmentedMeter("Disk use", value: 0.7, segments: 10, tone: .warning)
            UIFnSegmentedMeter("Battery", value: 0.1, segments: 5, tone: .danger)
        }
        WorkbenchSection("With a current value label") {
            UIFnSegmentedMeter(value: 0.6, segments: 5) {
                Text("Upload")
            } currentValueLabel: {
                Text("3 of 5 files")
            }
        }
    }
}

struct BannersScreen: View {
    @State private var showsPausedBanner = true

    var body: some View {
        WorkbenchSection("Tones") {
            UIFnBanner("Update available", message: "Restart to finish installing.", tone: .accent)
            UIFnBanner("Changes saved", tone: .success)
            UIFnBanner("Storage almost full", message: "Remove files you no longer need.", tone: .warning)
            UIFnBanner("Upload failed", message: "Check your connection and try again.", tone: .danger)
        }
        WorkbenchSection("Actions and dismiss") {
            if showsPausedBanner {
                UIFnBanner(
                    "Sync paused",
                    message: "Reconnect to keep your changes.",
                    tone: .warning,
                    dismiss: UIFnBannerDismiss("Dismiss") { showsPausedBanner = false }
                ) {
                    Button("Reconnect") { showsPausedBanner = false }
                }
            } else {
                Button("Show the banner again") { showsPausedBanner = true }.buttonStyle(.uifnSecondary)
            }
        }
    }
}

struct ToastsScreen: View {
    @Environment(\.workbenchShowToast) private var showToast

    var body: some View {
        WorkbenchSection("Toast") {
            Text("A toast shows over the bottom of the screen until it is dismissed.")
            // Kept until it is dismissed, so it stays for the accessibility audit.
            Button("Show toast") {
                showToast(UIFnToast("Link copied", message: "The link is on the clipboard.", tone: .success, duration: nil))
            }
            .buttonStyle(.uifnPrimary)
            .accessibilityIdentifier("toasts.show")
            Button("Show warning toast") {
                showToast(UIFnToast("Storage almost full", message: "Remove files you no longer need.", tone: .warning, duration: nil))
            }
            .buttonStyle(.uifnSecondary)
        }
    }
}

struct EmptyStatesScreen: View {
    @State private var lastAction = "None"

    var body: some View {
        WorkbenchSection("Icon, message and actions") {
            UIFnEmptyState("No files", message: "Files you add appear here.") {
                Image(systemName: "tray")
            } actions: {
                Button("Add a file") { lastAction = "Add a file" }.buttonStyle(.uifnPrimary)
                Button("Import") { lastAction = "Import" }.buttonStyle(.uifnSecondary)
            }
        }
        WorkbenchSection("Message only") {
            UIFnEmptyState("No results", message: "Try a different search.")
        }
        WorkbenchSection("Actions without an icon") {
            UIFnEmptyState("Inbox is empty", actions: {
                Button("Compose") { lastAction = "Compose" }.buttonStyle(.uifnSecondary)
            })
        }
        Text("Last action: \(lastAction)")
    }
}

struct SkeletonsScreen: View {
    var body: some View {
        WorkbenchSection("Text") {
            UIFnSkeleton("Loading the article") {
                VStack(alignment: .leading, spacing: 8) {
                    UIFnSkeletonBlock(.capsule).frame(height: 12)
                    UIFnSkeletonBlock(.capsule).frame(height: 12)
                    UIFnSkeletonBlock(.capsule).frame(width: 160, height: 12)
                }
            }
        }
        WorkbenchSection("Avatar and lines") {
            UIFnSkeleton("Loading messages") {
                HStack(spacing: 12) {
                    UIFnSkeletonBlock(.circle).frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 8) {
                        UIFnSkeletonBlock(.capsule).frame(width: 140, height: 12)
                        UIFnSkeletonBlock(.capsule).frame(width: 200, height: 12)
                    }
                }
            }
        }
        WorkbenchSection("Image") {
            UIFnSkeleton("Loading the preview", shape: .rectangle).frame(height: 120)
        }
    }
}
