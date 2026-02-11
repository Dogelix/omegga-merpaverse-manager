import https from 'https';
import http from 'http';

export function requestJson<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: any } = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            return reject(new Error(`HTTP ${status}: ${data.slice(0, 300)}`));
          }
          try {
            resolve(data ? JSON.parse(data) : (null as any));
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);

    if (opts.body !== undefined) {
      req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    }
    req.end();
  });
}
