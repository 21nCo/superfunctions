export interface ToolbarProps {
  orientation?: 'horizontal' | 'vertical';
}

export interface ToolbarState {
  orientation: 'horizontal' | 'vertical';
}

export function createToolbar(props: ToolbarProps) {
  const { orientation = 'horizontal' } = props;
  return {
    state: { orientation }
  };
}
