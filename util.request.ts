import { parse as parseUrl } from 'url';
import https from 'https';
import http from 'http';

export function request(
  urlStr: string,
  opts: { method?: string; headers?: Record<string, string>; body?: any } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = parseUrl(urlStr);
    if (!u.hostname || !u.pathname || !u.protocol) {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const path = (u.pathname ?? '/') + (u.search ?? '');
    const lib = u.protocol === 'https:' ? https : http;

    const bodyStr =
      opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.headers ?? {}),
          ...(bodyStr !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr).toString() }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );

    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}
