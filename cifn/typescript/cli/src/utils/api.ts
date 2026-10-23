export const API_URL = process.env.CIFN_API_URL || 'http://localhost:3000';
const API_KEY = process.env.CIFN_API_KEY || process.env.CIFN_TOKEN;

export async function apiCall(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${API_URL}${path}`;
  const headers = new Headers(options.headers);

  if (API_KEY) {
    headers.set('Authorization', `Bearer ${API_KEY}`);
  }
  
  // Default to JSON content type if body is present and not FormData
  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type');
  let data;
  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return { status: response.status, ok: response.ok, data };
}
