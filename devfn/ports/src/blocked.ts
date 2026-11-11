/**
 * The Fetch Standard's bad ports (https://fetch.spec.whatwg.org/#port-blocking).
 * fetch() and browsers refuse every request to one of them before connecting,
 * so an HTTP readiness check, a status probe or a browser could never reach a
 * process listening there. Port 4190 lies in the default fallback range.
 * The tests check that the runtime's fetch() refuses every listed port, and
 * that the set is exact across the default fallback range. The standard also
 * lists 0, which is not a connectable port: configuration rejects it and no
 * allocator yields it.
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Whether fetch() and browsers refuse every request to this port. */
export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}
