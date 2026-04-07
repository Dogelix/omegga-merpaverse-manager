import { parse as parseUrl } from 'url';
import https from 'https';
import http from 'http';
import { randomBytes } from 'crypto';
import { request } from './util.request';

export async function sendMessageViaWebhook(webhookUrl: string, message: string): Promise<void> {
  const { status, body } = await request(webhookUrl, {
    method: 'POST',
    body: { content: message },
  });

  if (status === 204) {
    console.log('Webhook sent (204 No Content).');
  } else if (status >= 200 && status < 300) {
    console.log('Webhook sent:', status, body);
  } else {
    console.warn('Webhook failed:', status, body);
  }
}

export function sendFileViaWebhook(
  webhookUrl: string,
  fileName: string,
  data: Buffer,
  contentType: string,
  description?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = parseUrl(webhookUrl);
    if (!u.hostname || !u.pathname || !u.protocol) {
      return reject(new Error(`Invalid webhook URL: ${webhookUrl}`));
    }

    const path = (u.pathname ?? "/") + (u.search ?? "");
    const lib = u.protocol === "https:" ? https : http;

    const boundary = "----omegga-" + randomBytes(12).toString("hex");
    const crlf = "\r\n";

    const payloadJson = Buffer.from(JSON.stringify({ content: description ?? `💾 Uploaded RP Log : ${fileName}` }), "utf8");

    const partPayload =
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="payload_json"${crlf}` +
      `Content-Type: application/json${crlf}${crlf}`;
    const partPayloadBuf = Buffer.from(partPayload, "utf8");

    const fileType = contentType ?? "application/octet-stream";
    const partFileHeader =
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="files[0]"; filename="${fileName}"${crlf}` +
      `Content-Type: ${fileType}${crlf}${crlf}`;
    const partFileHeaderBuf = Buffer.from(partFileHeader, "utf8");

    const trailer = Buffer.from(`${crlf}--${boundary}--${crlf}`, "utf8");

    const body = Buffer.concat([
      partPayloadBuf,
      payloadJson,
      Buffer.from(crlf, "utf8"),
      partFileHeaderBuf,
      data,
      trailer,
    ]);

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
        path,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let responseData = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseData += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseData }));
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function sendCachedRPChatLogs(webhookUrl: string, messages: string[]): Promise<void> {
  const content = messages.join("\n");
  await sendMessageViaWebhook(webhookUrl, content);
}
