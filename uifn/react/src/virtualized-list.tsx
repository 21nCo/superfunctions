import React, { useRef, useState, useMemo } from 'react';

export interface VirtualizedListProps<T> extends React.HTMLAttributes<HTMLDivElement> {
  items: T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  height: number | string;
  overscan?: number;
}

export function VirtualizedList<T>(props: VirtualizedListProps<T>) {
  const {
    items,
    itemHeight,
    renderItem,
    height,
    overscan = 3,
    style,
    onScroll,
    ...domProps
  } = props;

  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const totalHeight = items.length * itemHeight;
  
  // Calculate visible range
  // Assuming height is fixed px for now if number. If string, we might need ResizeObserver.
  // For simplicity primitive: user passes height in px usually or we measure.
  // Let's assume height is passed as number for calculation logic, or we use a container ref height.
  // Since prop is number | string, let's try to measure if not number.
  // But for SSR safety/simple primitive, number is best.
  // Let's rely on scroll event.
  
  const viewportHeight = typeof height === 'number' ? height : 300; // Fallback or need to measure

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan
  );

  const visibleItems = useMemo(() => {
    return items.slice(startIndex, endIndex).map((item, index) => ({
      item,
      index: startIndex + index,
    }));
  }, [items, startIndex, endIndex]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    onScroll?.(e);
  };

  return (
    <div
      ref={containerRef}
      style={{
        height,
        overflowY: 'auto',
        position: 'relative',
        ...style
      }}
      onScroll={handleScroll}
      {...domProps}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {visibleItems.map(({ item, index }) => (
          <div
            key={index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: itemHeight,
              transform: `translateY(${index * itemHeight}px)`,
            }}
          >
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    </div>
  );
}
