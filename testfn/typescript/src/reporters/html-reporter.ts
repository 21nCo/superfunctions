import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TestResult, TestRunSummary, Reporter } from "../types.js";

export class HtmlReporter implements Reporter {
  private outputPath: string;
  private results: TestResult[] = [];

  constructor(outputPath: string = "./testfn-report.html") {
    this.outputPath = outputPath;
  }

  onRunStart(): void {
    this.results = [];
  }

  onTestComplete(result: TestResult): void {
    this.results.push(result);
  }

  onRunComplete(summary: TestRunSummary): void {
    const html = this.generateHtml(summary, this.results);

    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, html, "utf-8");
  }

  private generateHtml(summary: TestRunSummary, results: TestResult[]): string {
    const passRate =
      summary.total > 0
        ? ((summary.passed / summary.total) * 100).toFixed(1)
        : "0";
    const failRate =
      summary.total > 0
        ? ((summary.failed / summary.total) * 100).toFixed(1)
        : "0";

    const statusColor = summary.failed === 0 ? "#10b981" : "#ef4444";
    const statusText =
      summary.total === 0
        ? "No tests executed"
        : summary.failed === 0
          ? "✓ All Tests Passed"
          : `✗ ${summary.failed} Test${summary.failed > 1 ? "s" : ""} Failed`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TestFn Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      padding: 2rem;
      color: #111827;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      background: white;
      border-radius: 12px;
      padding: 2rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 2rem;
    }
    .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .header .timestamp { color: #6b7280; font-size: 0.875rem; }
    .status {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-weight: 600;
      margin-top: 1rem;
      background: ${statusColor};
      color: white;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .card-label { color: #6b7280; font-size: 0.875rem; margin-bottom: 0.5rem; }
    .card-value { font-size: 2rem; font-weight: 700; }
    .card-value.success { color: #10b981; }
    .card-value.error { color: #ef4444; }
    .card-value.warning { color: #f59e0b; }
    .card-value.info { color: #3b82f6; }
    .chart {
      background: white;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 2rem;
    }
    .chart h3 { margin-bottom: 1rem; }
    .bar-chart {
      display: flex;
      height: 200px;
      align-items: flex-end;
      gap: 1rem;
      padding-top: 1rem;
    }
    .bar {
      flex: 1;
      background: linear-gradient(to top, #3b82f6, #60a5fa);
      border-radius: 4px 4px 0 0;
      position: relative;
      min-height: 20px;
    }
    .bar.passed { background: linear-gradient(to top, #10b981, #34d399); }
    .bar.failed { background: linear-gradient(to top, #ef4444, #f87171); }
    .bar-label {
      position: absolute;
      bottom: -25px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 0.75rem;
      color: #6b7280;
      white-space: nowrap;
    }
    .results {
      background: white;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .results h3 { margin-bottom: 1rem; }
    .test-item {
      padding: 1rem;
      border-bottom: 1px solid #e5e7eb;
      display: flex;
      align-items: flex-start;
      gap: 1rem;
    }
    .test-item:last-child { border-bottom: none; }
    .test-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      flex-shrink: 0;
    }
    .test-icon.passed { background: #d1fae5; color: #065f46; }
    .test-icon.failed { background: #fee2e2; color: #991b1b; }
    .test-icon.skipped { background: #fef3c7; color: #92400e; }
    .test-details { flex: 1; }
    .test-name { font-weight: 600; margin-bottom: 0.25rem; }
    .test-meta { color: #6b7280; font-size: 0.875rem; }
    .test-error {
      margin-top: 0.5rem;
      padding: 0.75rem;
      background: #fef2f2;
      border-left: 3px solid #ef4444;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 0.875rem;
      color: #991b1b;
      overflow-x: auto;
    }
    .filter-tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    .filter-tab {
      padding: 0.5rem 1rem;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      background: white;
      cursor: pointer;
      font-size: 0.875rem;
      transition: all 0.2s;
    }
    .filter-tab:hover { background: #f9fafb; }
    .filter-tab.active { background: #3b82f6; color: white; border-color: #3b82f6; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>TestFn Report</h1>
      <div class="timestamp">${new Date().toLocaleString()}</div>
      <div class="status">${statusText}</div>
    </div>

    <div class="summary">
      <div class="card">
        <div class="card-label">Total Tests</div>
        <div class="card-value info">${summary.total}</div>
      </div>
      <div class="card">
        <div class="card-label">Passed</div>
        <div class="card-value success">${summary.passed} (${passRate}%)</div>
      </div>
      <div class="card">
        <div class="card-label">Failed</div>
        <div class="card-value error">${summary.failed} (${failRate}%)</div>
      </div>
      <div class="card">
        <div class="card-label">Duration</div>
        <div class="card-value">${(summary.duration / 1000).toFixed(2)}s</div>
      </div>
    </div>

    <div class="chart">
      <h3>Test Results Overview</h3>
      <div class="bar-chart">
        <div class="bar passed" style="height: ${passRate}%">
          <span class="bar-label">Passed<br>${summary.passed}</span>
        </div>
        <div class="bar failed" style="height: ${failRate}%">
          <span class="bar-label">Failed<br>${summary.failed}</span>
        </div>
        ${
          summary.skipped > 0
            ? `<div class="bar" style="height: ${(summary.skipped / summary.total) * 100}%; background: linear-gradient(to top, #f59e0b, #fbbf24);">
          <span class="bar-label">Skipped<br>${summary.skipped}</span>
        </div>`
            : ""
        }
      </div>
    </div>

    <div class="results">
      <h3>Test Results (${results.length})</h3>
      <div class="filter-tabs">
        <button class="filter-tab active" onclick="filterTests('all', event)">All (${results.length})</button>
        <button class="filter-tab" onclick="filterTests('passed', event)">Passed (${summary.passed})</button>
        <button class="filter-tab" onclick="filterTests('failed', event)">Failed (${summary.failed})</button>
        ${summary.skipped > 0 ? `<button class="filter-tab" onclick="filterTests('skipped', event)">Skipped (${summary.skipped})</button>` : ""}
      </div>
      <div id="test-list">
        ${results
          .map(
            (result) => `
          <div class="test-item" data-status="${result.status}">
            <div class="test-icon ${result.status}">
              ${result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "○"}
            </div>
            <div class="test-details">
              <div class="test-name">${this.escapeHtml(result.id)}</div>
              <div class="test-meta">Duration: ${result.duration}ms</div>
              ${
                result.error
                  ? `
                <div class="test-error">
                  <strong>Error:</strong> ${this.escapeHtml(result.error.message)}
                  ${result.error.stack ? `<pre style="margin-top: 0.5rem; white-space: pre-wrap;">${this.escapeHtml(result.error.stack.split("\n").slice(0, 5).join("\n"))}</pre>` : ""}
                </div>
              `
                  : ""
              }
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  </div>

  <script>
    function filterTests(status, event) {
      const tabs = document.querySelectorAll('.filter-tab');
      tabs.forEach(tab => tab.classList.remove('active'));
      event.target.classList.add('active');

      const items = document.querySelectorAll('.test-item');
      items.forEach(item => {
        if (status === 'all' || item.dataset.status === status || (status === 'failed' && item.dataset.status === 'timeout')) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
