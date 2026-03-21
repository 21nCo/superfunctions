const COLOR = {
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  reset: "\u001b[0m",
} as const;

function colorize(color: keyof typeof COLOR, message: string): string {
  return `${COLOR[color]}${message}${COLOR.reset}`;
}

export interface Spinner {
  start(): void;
  stop(): void;
  succeed(message?: string): void;
  fail(message?: string): void;
}

function createSpinner(message: string): Spinner {
  const frames = ["-", "\\", "|", "/"];
  let timer: NodeJS.Timeout | null = null;
  let i = 0;
  let current = message;

  const render = () => {
    process.stdout.write(`\r${frames[i % frames.length]} ${current}`);
    i += 1;
  };

  return {
    start() {
      if (timer) {
        return;
      }
      render();
      timer = setInterval(render, 80);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write("\r");
      process.stdout.write(" ".repeat(Math.max(current.length + 2, 3)));
      process.stdout.write("\r");
    },
    succeed(nextMessage) {
      if (nextMessage) {
        current = nextMessage;
      }
      this.stop();
      process.stdout.write(`${colorize("green", `[ok] ${current}`)}\n`);
    },
    fail(nextMessage) {
      if (nextMessage) {
        current = nextMessage;
      }
      this.stop();
      process.stdout.write(`${colorize("red", `[x] ${current}`)}\n`);
    },
  };
}

function renderTable(rows: Array<Record<string, string | number>>): void {
  if (rows.length === 0) {
    process.stdout.write("(empty)\n");
    return;
  }

  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) => {
    const values = rows.map((row) => String(row[header] ?? ""));
    return Math.max(header.length, ...values.map((value) => value.length));
  });

  const printLine = (values: string[]) => {
    const cells = values.map((value, idx) => value.padEnd(widths[idx], " "));
    process.stdout.write(`${cells.join(" | ")}\n`);
  };

  printLine(headers);
  printLine(widths.map((width) => "-".repeat(width)));
  for (const row of rows) {
    printLine(headers.map((header) => String(row[header] ?? "")));
  }
}

export const ui = {
  success(message: string): void {
    process.stdout.write(`${colorize("green", `[ok] ${message}`)}\n`);
  },
  error(message: string): void {
    process.stderr.write(`${colorize("red", `[x] ${message}`)}\n`);
  },
  warn(message: string): void {
    process.stdout.write(`${colorize("yellow", `[!] ${message}`)}\n`);
  },
  info(message: string): void {
    process.stdout.write(`${colorize("blue", `[i] ${message}`)}\n`);
  },
  spinner(message: string): Spinner {
    return createSpinner(message);
  },
  table(rows: Array<Record<string, string | number>>): void {
    renderTable(rows);
  },
};
