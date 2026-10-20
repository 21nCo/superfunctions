// Simplified Web Vitals collection
export function onLCP(cb: (metric: any) => void) {
  return observe('largest-contentful-paint', (entries) => {
    const lastEntry = entries[entries.length - 1] as (PerformanceEntry & { id?: string }) | undefined;
    if (!lastEntry) return;
    cb({ name: 'LCP', value: lastEntry.startTime, id: lastEntry.id });
  });
}

export function onFID(cb: (metric: any) => void) {
  return observe('first-input', (entries) => {
    const entry = entries[0] as any;
    cb({
      name: 'FID',
      value: entry.processingStart - entry.startTime,
      id: entry.name,
    });
  });
}

export function onCLS(cb: (metric: any) => void) {
  let cls = 0;
  return observe('layout-shift', (entries) => {
    for (const entry of entries as any[]) {
      if (!entry.hadRecentInput) {
        cls += entry.value;
      }
    }
    cb({ name: 'CLS', value: cls });
  });
}

function observe(type: string, cb: (entries: PerformanceEntryList) => void) {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  try {
    const observer = new PerformanceObserver((entryList) => {
      cb(entryList.getEntries());
    });
    observer.observe({ type, buffered: true });
    return () => observer.disconnect();
  } catch (e) {
    return () => {};
  }
}
