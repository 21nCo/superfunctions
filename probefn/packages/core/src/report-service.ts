import {
  buildReportJson,
  renderReportMarkdown,
  type ReportJsonDocument,
  type SessionStateLike,
} from '@probefn/session-reporter';
import {
  ArtifactStore,
  countRedactedPlaceholders,
  filterSensitiveExportData,
} from '@probefn/storage';

export interface ReportServiceOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
}

export interface ExportedReport {
  reportPath: string;
  tracePath: string | null;
  redactedValueCount: number;
  warnings: string[];
  includes: string[];
  reportData: ReportJsonDocument;
}

export class ReportService {
  private readonly repoRoot: string;
  private readonly artifactStore: ArtifactStore;

  public constructor(options: ReportServiceOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactStore = options.artifactStore;
  }

  public async exportReport(
    input: {
      session: SessionStateLike & {
        runId: string;
      };
      format: 'json' | 'markdown';
    },
  ): Promise<ExportedReport> {
    const builtReport = await buildReportJson({
      repoRoot: this.repoRoot,
      session: input.session,
    });
    const filteredReport = filterSensitiveExportData(builtReport.report);
    const reportPath = await this.artifactStore.writeReport(
      input.session.runId,
      input.format,
      input.format === 'json'
        ? (filteredReport.value as unknown as Record<string, unknown>)
        : renderReportMarkdown(filteredReport.value),
    );

    return {
      reportPath,
      tracePath: filteredReport.value.tracePath,
      redactedValueCount: countRedactedPlaceholders(filteredReport.value),
      warnings: [
        ...builtReport.warnings,
        ...(filteredReport.omittedAuthProfilePaths > 0
          ? ['Sensitive auth-profile artifact references were omitted from export.']
          : []),
      ],
      includes: builtReport.includes,
      reportData: filteredReport.value,
    };
  }
}
