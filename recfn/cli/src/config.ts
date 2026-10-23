export interface CliConfig {
  apiKey: string;
  baseUrl: string;
}

export function loadConfig(): CliConfig {
  const apiKey = process.env.RECFN_API_KEY;
  const baseUrl = process.env.RECFN_SERVER_URL ?? process.env.RECFN_BASE_URL ?? 'http://localhost:3000';

  if (!apiKey || !apiKey.trim()) {
    console.error('Error: RECFN_API_KEY environment variable is required.');
    process.exit(1);
  }

  return {
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.replace(/\/$/, ''),
  };
}
