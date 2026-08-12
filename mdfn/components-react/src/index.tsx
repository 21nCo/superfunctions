"use client";

import * as React from "react";
import { ToolbarButton, ToolbarRoot } from "@uifn/components-react";
import { createToolbarModel, runToolbarAction, type ToolbarCommandTarget, type ToolbarGroup } from "@mdfn/components";
import type { EditorController } from "@mdfn/core";
import { MdfnEditor, useMdfn, type MdfnEditorHandle, type MdfnEditorProps } from "@mdfn/react";

export interface MdfnToolbarProps extends Omit<React.ComponentProps<typeof ToolbarRoot>, "children"> {
  readonly controller: EditorController;
  readonly groups?: readonly ToolbarGroup[];
  readonly ariaLabel?: string;
  readonly commandTarget?: ToolbarCommandTarget | null;
}

export function MdfnToolbar({ controller, groups, ariaLabel, commandTarget, ...props }: MdfnToolbarProps): React.ReactElement {
  useMdfn(controller);
  const model = createToolbarModel(controller, groups, ariaLabel, commandTarget);
  return (
    <ToolbarRoot {...props} data-mdfn-component="toolbar" aria-label={model.ariaLabel}>
      {model.groups.map((group) => (
        <span key={group.id} role="group" aria-label={group.label} data-mdfn-toolbar-group={group.id}>
          {group.actions.map((action) => (
            <ToolbarButton key={action.id} value={action.id} type="button" disabled={action.disabled} aria-label={action.label} aria-pressed={action.pressed} title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label} onClick={() => runToolbarAction(controller, action, commandTarget)}>
              {action.label}
            </ToolbarButton>
          ))}
        </span>
      ))}
    </ToolbarRoot>
  );
}

export interface MdfnEditorShellProps extends MdfnEditorProps {
  readonly toolbarGroups?: readonly ToolbarGroup[];
  readonly hideToolbar?: boolean;
}

export const MdfnEditorShell = React.forwardRef<React.ElementRef<typeof MdfnEditor>, MdfnEditorShellProps>(function MdfnEditorShell(
  { toolbarGroups, hideToolbar, className, onReady, ...props }, forwardedRef,
) {
  const [commandTarget, setCommandTarget] = React.useState<ToolbarCommandTarget | null>(null);
  const setEditorRef = React.useCallback((handle: MdfnEditorHandle | null) => {
    setCommandTarget(handle ? {
      can: (command) => handle.can(command as Parameters<MdfnEditorHandle["can"]>[0]),
      run: (command) => handle.run(command as Parameters<MdfnEditorHandle["run"]>[0]),
    } : null);
    if (typeof forwardedRef === "function") forwardedRef(handle);
    else if (forwardedRef) forwardedRef.current = handle;
  }, [forwardedRef]);
  const editorReady = React.useCallback((handle: MdfnEditorHandle) => {
    setCommandTarget({
      can: (command) => handle.can(command as Parameters<MdfnEditorHandle["can"]>[0]),
      run: (command) => handle.run(command as Parameters<MdfnEditorHandle["run"]>[0]),
    });
    onReady?.(handle);
  }, [onReady]);
  return (
    <div className={className} data-mdfn-component="editor-shell">
      {!hideToolbar && !props.readOnly && <MdfnToolbar controller={props.controller} groups={toolbarGroups} commandTarget={commandTarget} />}
      <MdfnEditor {...props} ref={setEditorRef} onReady={editorReady} />
    </div>
  );
});

export { MdfnEditor } from "@mdfn/react";
export const MDFN_COMPONENTS_REACT_VERSION = "0.1.0" as const;
