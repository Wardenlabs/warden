import type { Request } from 'express';

/** CORS controls response reads, not simple POSTs. A browser on another site
 * must never inherit the local console's passwordless administration. Host
 * validation also prevents an attacker-controlled DNS name from rebinding
 * to loopback and presenting itself as the same origin. */
export function browserAllowsLocalTrust(req: Request): boolean {
  const host = req.header('host');
  if (!host) return false;
  let target: URL;
  try { target = new URL(`${req.protocol || 'http'}://${host}`); }
  catch { return false; }
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const local = req.socket.localAddress?.replace(/^::ffff:/, '');
  if (hostname !== 'localhost' && hostname !== '::1' && hostname !== local && !/^127\.\d+\.\d+\.\d+$/.test(hostname)) return false;

  const origin = req.header('origin');
  const configured = process.env['WARDEN_CORS_ORIGIN'];
  if (origin) return origin === target.origin || (configured !== '*' && origin !== 'null' && origin === configured);
  const site = req.header('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}
