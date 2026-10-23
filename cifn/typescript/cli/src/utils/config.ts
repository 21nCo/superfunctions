import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface PipelineConfig {
  [key: string]: any;
}

export function loadConfig(configPath?: string): { config: PipelineConfig; path: string } {
  let filePath = configPath;

  if (!filePath) {
    if (process.env.CIFN_CONFIG) {
      filePath = process.env.CIFN_CONFIG;
    } else {
      const defaults = ['.ci/pipeline.yml', '.ci/pipeline.yaml', 'cifn.yml', 'cifn.yaml'];
      for (const p of defaults) {
        if (fs.existsSync(p)) {
          filePath = p;
          break;
        }
      }
    }
  }

  if (!filePath) {
    throw new Error('Pipeline config file not found. Please provide --config or set CIFN_CONFIG, or ensure one of these exists: .ci/pipeline.yml, .ci/pipeline.yaml, cifn.yml, cifn.yaml');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let config: PipelineConfig;

  if (filePath.endsWith('.json')) {
    config = JSON.parse(content);
  } else {
    config = yaml.load(content) as PipelineConfig;
  }

  return { config, path: filePath };
}
