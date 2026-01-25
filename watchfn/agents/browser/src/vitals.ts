// Simplified Web Vitals collection
export function onLCP(cb: (metric: any) => void) {
  observe('largest-contentful-paint', (entries) => {
    const lastEntry = entries[entries.length - 1];
    cb({ name: 'LCP', value: lastEntry.startTime, id: lastEntry.id });
  });
}

export function onFID(cb: (metric: any) => void) {
  observe('first-input', (entries) => {
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
  observe('layout-shift', (entries) => {
    for (const entry of entries as any[]) {
      if (!entry.hadRecentInput) {
        cls += entry.value;
      }
    }
    cb({ name: 'CLS', value: cls });
  });
}

function observe(type: string, cb: (entries: PerformanceEntryList) => void) {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    new PerformanceObserver((entryList) => {
      cb(entryList.getEntries());
    }).observe({ type, buffered: true });
  } catch (e) {
    // Do nothing
  }
}
