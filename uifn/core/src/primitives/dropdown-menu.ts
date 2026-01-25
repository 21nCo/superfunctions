import { createPopover, PopoverProps, PopoverState } from './popover';

export type DropdownMenuProps = PopoverProps;
export type DropdownMenuState = PopoverState;

export function createDropdownMenu(props: DropdownMenuProps) {
  return createPopover(props);
}