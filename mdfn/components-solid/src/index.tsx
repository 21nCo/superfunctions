import { createSignal, For, type Component } from "solid-js";
import { ToolbarButton, ToolbarRoot } from "@uifn/components-solid";
import { createToolbarModel, runToolbarAction, type ToolbarCommandTarget, type ToolbarGroup } from "@mdfn/components";
import type { EditorController } from "@mdfn/core";
import { MdfnEditor, createMdfnSignal, type MdfnEditorHandle, type MdfnEditorProps } from "@mdfn/solid";

export const MdfnToolbar: Component<{ controller: EditorController; groups?: readonly ToolbarGroup[]; ariaLabel?: string; class?: string; commandTarget?: ToolbarCommandTarget | null }> = (props) => {
  const snapshot = createMdfnSignal(props.controller);
  const model = () => { snapshot().version; return createToolbarModel(props.controller, props.groups, props.ariaLabel, props.commandTarget); };
  return <ToolbarRoot class={props.class} data-mdfn-component="toolbar" aria-label={model().ariaLabel}>
    <For each={model().groups}>{(group) => <span role="group" aria-label={group.label} data-mdfn-toolbar-group={group.id}>
      <For each={group.actions}>{(action) => <ToolbarButton value={action.id} type="button" disabled={action.disabled} aria-label={action.label} aria-pressed={action.pressed} title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label} onClick={() => runToolbarAction(props.controller, action, props.commandTarget)}>{action.label}</ToolbarButton>}</For>
    </span>}</For>
  </ToolbarRoot>;
};

export interface MdfnEditorShellProps extends MdfnEditorProps { readonly toolbarGroups?: readonly ToolbarGroup[]; readonly hideToolbar?: boolean; }
export const MdfnEditorShell: Component<MdfnEditorShellProps> = (props) => {
  const [commandTarget, setCommandTarget] = createSignal<ToolbarCommandTarget | null>(null);
  const setEditor = (value: MdfnEditorHandle | null): void => {
    setCommandTarget(value ? {
      can: (command) => value.can(command as Parameters<MdfnEditorHandle["can"]>[0]),
      run: (command) => value.run(command as Parameters<MdfnEditorHandle["run"]>[0]),
    } : null);
    props.editorRef?.(value);
  };
  return <div data-mdfn-component="editor-shell">
    {!props.hideToolbar && !props.readOnly && <MdfnToolbar controller={props.controller} groups={props.toolbarGroups} commandTarget={commandTarget()} />}
    <MdfnEditor {...props} editorRef={setEditor} />
  </div>;
};

export { MdfnEditor } from "@mdfn/solid";
export const MDFN_COMPONENTS_SOLID_VERSION = "0.1.0" as const;
