import {
  buildReportJson,
  assembleReportJson,
  renderReportMarkdown,
  type ReportJsonDocument,
  type SessionStateLike,
} from '@probefn/session-reporter';
import {
  ArtifactStore,
  countRedactedPlaceholders,
  filterSensitiveExportData,
  redactSensitiveData,
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

  /** Lossless artifact export without returning or retaining the complete event index. */
  public async exportReportArtifact(input: {
    session: SessionStateLike & { runId: string };
    format: 'json' | 'markdown';
  }): Promise<Omit<ExportedReport, 'reportData'>> {
    const paths = this.artifactStore.getRunPaths(input.session.runId);
    const target = input.format === 'json' ? paths.reportJsonPath : paths.reportMarkdownPath;
    let result!: Omit<ExportedReport, 'reportData'>;
    await this.artifactStore.writeArtifactStream(target, async write => {
      let omitted = 0;
      let redactedValueCount = 0;
      let currentKey: string | undefined;
      let first = true;
      const filter = <T,>(value: T): T => {
        const filtered = filterSensitiveExportData(value);
        omitted += filtered.omittedAuthProfilePaths;
        redactedValueCount += countRedactedPlaceholders(filtered.value);
        return filtered.value;
      };
      if (input.format === 'json') await write('{"eventIndex":{');
      const built = await assembleReportJson({
        repoRoot: this.repoRoot, session: input.session,
        eventConsumer: async (key, event) => {
          if (input.format === 'json' && currentKey !== key) {
            await write(`${currentKey === undefined ? '' : ','}${JSON.stringify(key)}:[`);
            currentKey = key;
            first = true;
          }
          if (event) {
            const filtered = filter(event);
            if (input.format === 'json') {
              await write(`${first ? '' : ','}${JSON.stringify(redactSensitiveData(filtered).value)}\n`);
              first = false;
            }
          } else if (input.format === 'json') await write(']');
        },
      });
      // Only the metadata is retained. Witnesses were used by correlation before
      // filtering, just as in the compatibility builder; do not count them twice.
      built.report.eventIndex = { actions: [], console: [], pageErrors: [], network: [], devServerStdout: [], devServerStderr: [] };
      const metadata = filter(built.report);
      if (input.format === 'json') {
        const { eventIndex: _events, ...rest } = redactSensitiveData(metadata).value;
        await write(`},${JSON.stringify(rest).slice(1)}\n`);
      } else {
        await write(redactSensitiveData(renderReportMarkdown(metadata)).value);
      }
      result = {
        reportPath: target, tracePath: metadata.tracePath, redactedValueCount,
        warnings: [...built.warnings, ...(omitted > 0 ? ['Sensitive auth-profile artifact references were omitted from export.'] : [])],
        includes: built.includes,
      };
    });
    return result;
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
