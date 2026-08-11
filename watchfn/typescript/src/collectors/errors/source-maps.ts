/** Source map support for error tracking. */

export interface SourceMapPosition {
  source: string;
  line: number;
  column: number;
  name?: string;
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
  functionName?: string;
  source?: string;
}

export class SourceMapResolver {
  private sourceMaps: Map<string, any> = new Map();

  /**
   * Load a source map for a file
   */
  async loadSourceMap(file: string, sourceMapContent: string): Promise<void> {
    try {
      const sourceMap = JSON.parse(sourceMapContent);
      this.sourceMaps.set(file, sourceMap);
    } catch (error) {
      console.error(`Failed to load source map for ${file}:`, error);
    }
  }

  /**
   * Resolve a stack frame to original source position
   */
  async resolveFrame(frame: StackFrame): Promise<StackFrame> {
    const sourceMap = this.sourceMaps.get(frame.file);
    if (!sourceMap) {
      return frame;
    }

    try {
      const position = await this.resolvePosition(sourceMap, frame.line, frame.column);
      if (position) {
        return {
          ...frame,
          file: position.source,
          line: position.line,
          column: position.column,
          functionName: position.name || frame.functionName,
          source: await this.getSourceLine(position.source, position.line),
        };
      }
    } catch (error) {
      console.error(`Failed to resolve frame:`, error);
    }

    return frame;
  }

  /**
   * Resolve a stack trace
   */
  async resolveStackTrace(frames: StackFrame[]): Promise<StackFrame[]> {
    return Promise.all(frames.map((frame) => this.resolveFrame(frame)));
  }

  /**
   * Parse stack trace string into frames
   */
  parseStackTrace(stackTrace: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stackTrace.split("\n");

    for (const line of lines) {
      const frame = this.parseStackLine(line);
      if (frame) {
        frames.push(frame);
      }
    }

    return frames;
  }

  private parseStackLine(line: string): StackFrame | null {
    // Match various stack trace formats
    const patterns = [
      // Chrome/V8: at functionName (file:line:column)
      /at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/,
      // Firefox: functionName@file:line:column
      /(.+?)@(.+?):(\d+):(\d+)/,
      // Other: file:line:column
      /(.+?):(\d+):(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        if (match.length === 5) {
          return {
            functionName: match[1],
            file: match[2],
            line: parseInt(match[3], 10),
            column: parseInt(match[4], 10),
          };
        } else if (match.length === 4) {
          return {
            file: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
          };
        }
      }
    }

    return null;
  }

  private async resolvePosition(sourceMap: any, line: number, column: number): Promise<SourceMapPosition | null> {
    // Simple source map resolution (in production, use source-map library)
    // This is a placeholder implementation
    return null;
  }

  private async getSourceLine(file: string, line: number): Promise<string | undefined> {
    // Fetch and return the source line
    // In production, cache source files
    return undefined;
  }
}
