# Feedback dialog acknowledgement and keyboard behavior

2026-10-23. Each widget opening captures one identity and idempotency key. The first submission freezes its payload; explicit retries retain that key and payload after an uncertain acknowledgement. Fields remain disabled after submission. Success appears only after acknowledgement. Identity changes dismiss the widget, and late completions cannot restore a dismissed dialog.

The widget has labelled inputs, an accessible modal name, focus containment, Escape dismissal, opener restoration and live status messages. Required inputs and service length limits are applied in the UI.

Validation: 235 SDK tests, strict types and dual builds passed. The actual Chrome154 built-SDK/HTTP/SQLite fixture commits feedback then returns503; explicit retry sends the same key and body and leaves exactly one stored row. It also checks keyboard behavior, frozen fields and dismissal during a pending response after identity changes. Existing survey cases pass. Logs: /tmp/user-feedback-dialog-{tests,types,build,native}.log. Owned fixture resources are cleaned.

The retry key survives only while this dialog remains open. Closing, reopening or reloading does not reconcile an uncertain prior submission; a durable response journal remains outstanding. This does not establish full accessibility certification or acceptance in other browser engines.
