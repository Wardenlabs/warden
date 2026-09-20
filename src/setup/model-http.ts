import { lookup } from 'node:dns';
import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { TransferError } from './model-files.js';

export type ModelResponse = Readable & { statusCode?: number; headers: IncomingHttpHeaders };
export type ModelRequest = (url: string, method: 'HEAD' | 'GET', headers: Record<string, string>, signal: AbortSignal) => Promise<ModelResponse>;
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) !== 6) return false;
  const a = address.toLowerCase();
  return /^[23]/.test(a) && !a.startsWith('2001:') && !a.startsWith('2002:');
}
export const requestModel: ModelRequest = (url, method, headers, signal) => publicResponse(url, method, headers, signal);
function publicResponse(raw: string, method: 'HEAD' | 'GET', headers: Record<string, string>, signal: AbortSignal, redirects = 0): Promise<ModelResponse> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || redirects > 5) throw new TransferError('unsafe_url', 'Use a public HTTPS download URL without credentials.');
  if (isIP(host) && !publicAddress(host)) throw new TransferError('unsafe_address', 'Model downloads require a public internet address.');
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { 'accept-encoding': 'identity', ...headers }, signal, lookup(hostname, options, callback) {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, '', 4);
        if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return callback(new TransferError('unsafe_address', 'Model downloads require a public internet address.'), '', 4);
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      });
    } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        const location = new URL(response.headers.location, url).href;
        response.destroy();
        try { resolve(publicResponse(location, method, headers, signal, redirects + 1)); } catch (error) { reject(error); }
      } else resolve(response);
    });
    req.setTimeout(30_000, () => req.destroy(new TransferError('network_timeout', 'The model download stopped responding.', 400, true)));
    req.on('error', reject);
    req.end();
  });
}
export function requireModelResponse(response: ModelResponse, allowed = [200]): void {
  if (!allowed.includes(response.statusCode ?? 0)) {
    response.destroy();
    throw new TransferError('upstream_http', `Model download returned HTTP ${response.statusCode ?? 'unknown'}.`, 400, (response.statusCode ?? 0) >= 500);
  }
  if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
    response.destroy();
    throw new TransferError('invalid_encoding', 'The model server returned an unsupported transfer encoding.');
  }
}
