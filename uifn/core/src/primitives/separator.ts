export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  decorative?: boolean;
}

export interface SeparatorState {
  orientation: 'horizontal' | 'vertical';
  decorative: boolean;
}

export function createSeparator(props: SeparatorProps) {
  const { orientation = 'horizontal', decorative = false } = props;
  
  return {
    state: { orientation, decorative }
  };
}
