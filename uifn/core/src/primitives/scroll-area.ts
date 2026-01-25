export interface ScrollAreaProps {
  type?: 'auto' | 'always' | 'scroll' | 'hover';
  scrollHideDelay?: number;
}

export interface ScrollAreaState {
  type: 'auto' | 'always' | 'scroll' | 'hover';
}

export function createScrollArea(props: ScrollAreaProps) {
  const { type = 'hover' } = props;
  return {
    state: { type }
  };
}
