import { createEffect, createSignal, onCleanup, splitProps, type Accessor, type Component, type JSX } from "solid-js";
import { createAdapterBridge, type AdapterSnapshot } from "@mdfn/adapter-kit";
import { Transaction, type EditorController } from "@mdfn/core";
import type { DomCommand, DomEditor } from "@mdfn/dom";
import type { EditorMode, SourceEditor } from "@mdfn/source";

export function createMdfnSignal(controller: EditorController): Accessor<AdapterSnapshot> {
  const bridge = createAdapterBridge(controller);
  const [snapshot, setSnapshot] = createSignal(bridge.getSnapshot());
  const unsubscribe = bridge.subscribe(() => setSnapshot(bridge.getSnapshot()));
  onCleanup(() => { unsubscribe(); bridge.destroy(); });
  return snapshot;
}

export interface MdfnEditorProps extends JSX.HTMLAttributes<HTMLDivElement> {
  readonly controller: EditorController;
  readonly mode?: EditorMode;
  readonly readOnly?: boolean;
  readonly ariaLabel?: string;
  readonly onLoadError?: (error: Error) => void;
  readonly editorRef?: (value: MdfnEditorHandle | null) => void;
}

export interface MdfnEditorHandle { focus(): void; run(command: DomCommand): boolean; can(command: DomCommand): boolean; }

export const MdfnEditor: Component<MdfnEditorProps> = (props) => {
  const [local, rest] = splitProps(props, ["controller", "mode", "readOnly", "ariaLabel", "onLoadError", "editorRef"]);
  const snapshot = createMdfnSignal(local.controller);
  let visualTarget: HTMLDivElement | undefined;
  let sourceTarget: HTMLDivElement | undefined;
  let previewTarget: HTMLDivElement | undefined;
  let visual: DomEditor | undefined;
  let source: SourceEditor | undefined;
  const [loadError, setLoadError] = createSignal<Error | null>(null);
  const [fallbackValue, setFallbackValue] = createSignal(local.controller.getState().markdown);
  const unsubscribe = local.controller.subscribe((change) => setFallbackValue(change.current.markdown));
  onCleanup(unsubscribe);

  const publishHandle = (): void => local.editorRef?.({ focus() { visual?.focus(); source?.focus(); }, run(command) { return visual?.run(command) ?? false; }, can(command) { return visual?.can(command) ?? false; } });
  publishHandle();

  createEffect(() => {
    const mode = local.mode ?? "visual";
    let cancelled = false;
    visual?.destroy();
    source?.destroy();
    visual = undefined;
    source = undefined;
    const mount = async (): Promise<void> => {
      try {
        if ((mode === "visual" || mode === "split") && visualTarget) {
          const module = await import("@mdfn/dom");
          if (cancelled) return;
          visual = module.createDomEditor({ target: visualTarget, controller: local.controller, readOnly: local.readOnly, attributes: { "aria-label": local.ariaLabel ?? "Markdown editor" } });
        }
        if ((mode === "source" || mode === "split") && sourceTarget) {
          const module = await import("@mdfn/source");
          if (cancelled) return;
          source = module.createSourceEditor({ target: sourceTarget, controller: local.controller, readOnly: local.readOnly, ariaLabel: `${local.ariaLabel ?? "Markdown editor"} source` });
        }
        if ((mode === "preview" || mode === "read-only") && previewTarget) {
          const module = await import("@mdfn/source");
          if (cancelled) return;
          previewTarget.innerHTML = module.createPreview(local.controller).html;
        }
        publishHandle();
      } catch (error) {
        const resolved = error instanceof Error ? error : new Error(String(error));
        setLoadError(resolved);
        local.onLoadError?.(resolved);
      }
    };
    void mount();
    onCleanup(() => { cancelled = true; local.editorRef?.(null); visual?.destroy(); source?.destroy(); visual = undefined; source = undefined; });
  });

  createEffect(() => {
    snapshot().version;
    const mode = local.mode ?? "visual";
    if ((mode !== "preview" && mode !== "read-only") || !previewTarget) return;
    void import("@mdfn/source").then((module) => {
      if (previewTarget) previewTarget.innerHTML = module.createPreview(local.controller).html;
    }).catch((error: unknown) => {
      const resolved = error instanceof Error ? error : new Error(String(error));
      setLoadError(resolved);
      local.onLoadError?.(resolved);
    });
  });

  const updateFallback: JSX.EventHandler<HTMLTextAreaElement, InputEvent> = (event) => {
    const markdown = event.currentTarget.value;
    const current = local.controller.getState().markdown;
    local.controller.dispatch(new Transaction().replaceSource(0, current.length, markdown).withSource("solid:fallback"));
  };

  return (
    <div {...rest} data-mdfn-solid="editor" data-mode={local.mode ?? "visual"}>
      {loadError() ? (
        <div data-mdfn-source-fallback="true">
          <div role="status">Visual editor unavailable: {loadError()!.message}</div>
          <textarea aria-label={`${local.ariaLabel ?? "Markdown editor"} source fallback`} value={fallbackValue()} readOnly={local.readOnly} onInput={updateFallback} />
        </div>
      ) : (
        <>
          {((local.mode ?? "visual") === "visual" || local.mode === "split") && <div ref={visualTarget} data-mdfn-surface="visual" />}
          {(local.mode === "source" || local.mode === "split") && <div ref={sourceTarget} data-mdfn-surface="source" />}
          {(local.mode === "preview" || local.mode === "read-only") && <div ref={previewTarget} data-mdfn-surface="preview" aria-label={local.ariaLabel ?? "Markdown editor"} />}
        </>
      )}
    </div>
  );
};

export const MDFN_SOLID_VERSION = "0.1.0" as const;
