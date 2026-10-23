import type { ReportJsonDocument } from './report-json.js';

export function renderReportMarkdown(report: ReportJsonDocument): string {
  const lines = [
    '# Probefn Run Report',
    '',
    `- Session: \`${report.runMetadata.sessionId}\``,
    `- Run: \`${report.runMetadata.runId}\``,
    `- Mode: \`${report.runMetadata.mode}\``,
    `- Browser: \`${report.runMetadata.browser}\``,
    `- Status: \`${report.runMetadata.status}\``,
    `- Artifact root: \`${report.runMetadata.artifactRoot}\``,
    `- Manifest: \`${report.artifactReferences.manifestPath}\``,
    `- Trace: \`${report.tracePath ?? 'missing'}\``,
    '',
    '## Hypotheses',
    '',
  ];

  if (report.hypotheses.length === 0) {
    lines.push(`- Unresolved: ${report.unresolvedReason ?? 'No root-cause hypothesis was generated.'}`);
  } else {
    for (const hypothesis of report.hypotheses) {
      lines.push(`- ${hypothesis.statement} (confidence ${hypothesis.confidence.toFixed(2)})`);
      lines.push(`  evidence events: ${hypothesis.evidenceEventIds.map((eventId: string) => `\`${eventId}\``).join(', ')}`);
      lines.push(`  artifact paths: ${hypothesis.evidenceArtifactPaths.map((artifactPath: string) => `\`${artifactPath}\``).join(', ')}`);
    }
  }

  lines.push('', '## Findings', '');
  if (report.findings.length === 0) {
    lines.push('- None.');
  } else {
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.summary}`);
    }
  }

  lines.push('', '## Regressions', '');
  if (report.regressions.length === 0) {
    lines.push('- None.');
  } else {
    for (const regression of report.regressions) {
      lines.push(`- ${regression.baselineKey}: ${regression.pixelDiffPercent.toFixed(1)}% pixel drift (\`${regression.diffPath}\`)`);
    }
  }

  lines.push('', '## Checkpoints', '');
  if (report.checkpointIndex.length === 0) {
    lines.push('- None.');
  } else {
    for (const checkpoint of report.checkpointIndex) {
      lines.push(`- \`${checkpoint.checkpointId}\` at \`${checkpoint.manifestPath}\``);
      lines.push(`  URL: \`${checkpoint.url}\``);
      lines.push(`  Viewport: \`${checkpoint.viewport.width}x${checkpoint.viewport.height}\``);
      lines.push(`  Artifacts: ${checkpoint.artifacts.map((artifact: { path: string }) => `\`${artifact.path}\``).join(', ')}`);
    }
  }

  lines.push('', '## Artifact References', '');
  lines.push(`- Manifest: \`${report.artifactReferences.manifestPath}\``);
  for (const trace of report.tracePaths ?? []) lines.push(`- Trace chunk: \`${trace}\``);
  lines.push(`- Trace: \`${report.tracePath ?? 'missing'}\``);

  for (const [label, sinkPath] of Object.entries(report.artifactReferences.eventSinks)) {
    lines.push(`- Event sink (${label}): \`${sinkPath}\``);
  }

  for (const checkpointPath of report.artifactReferences.checkpoints) {
    lines.push(`- Checkpoint manifest: \`${checkpointPath}\``);
  }

  for (const diffPath of report.artifactReferences.diffs) {
    lines.push(`- Diff summary: \`${diffPath}\``);
  }

  return `${lines.join('\n')}\n`;
}
