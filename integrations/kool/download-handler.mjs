import { createKoolClient, KoolApiError } from './sdk-server.mjs';

export const DOWNLOAD_EVENT = 'warden_download_started';
export const INSTALLERS = Object.freeze({
  macos: 'https://github.com/Wardenlabs/warden/releases/latest/download/Warden-arm64.dmg',
  windows: 'https://github.com/Wardenlabs/warden/releases/latest/download/Warden-Setup.exe',
});

const MAX_BODY_BYTES = 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const BODY_FIELDS = new Set(['platform', 'eventId', 'clickId']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

class InvalidRequest extends Error {
  constructor(status = 400) {
    super('Invalid download request.');
    this.status = status;
  }
}

function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

function sameOrigin(req) {
  if (header(req, 'sec-fetch-site') === 'cross-site') return false;
  try {
    const origin = header(req, 'origin');
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.host === header(req, 'host') &&
      (parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)));
  } catch {
    return false;
  }
}

function rawBody(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error) => {
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', failed);
      req.removeListener('aborted', failed);
      if (error) {
        req.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const data = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) finish(new InvalidRequest(413));
      else chunks.push(bytes);
    };
    const end = () => finish();
    const failed = () => finish(new InvalidRequest());
    const timer = setTimeout(() => finish(new InvalidRequest(408)), timeoutMs);
    req.on('data', data);
    req.once('end', end);
    req.once('error', failed);
    req.once('aborted', failed);
  });
}

async function operationFrom(req, timeoutMs, test) {
  if (!sameOrigin(req)) throw new InvalidRequest(403);
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(
    header(req, 'content-type') ?? '',
  )) throw new InvalidRequest(415);
  const length = header(req, 'content-length');
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new InvalidRequest(413);
  }

  const body = req.body === undefined ? await rawBody(req, timeoutMs) : req.body;
  let entries;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new InvalidRequest(413);
    entries = [...new URLSearchParams(body.toString())];
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    entries = Object.entries(body);
  } else {
    throw new InvalidRequest();
  }

  const fields = Object.create(null);
  for (const [key, value] of entries) {
    if (!BODY_FIELDS.has(key) || Object.hasOwn(fields, key) || typeof value !== 'string') {
      throw new InvalidRequest();
    }
    fields[key] = value;
  }
  if (Buffer.byteLength(new URLSearchParams(entries).toString()) > MAX_BODY_BYTES) {
    throw new InvalidRequest(413);
  }
  if (!Object.hasOwn(INSTALLERS, fields.platform) || !UUID_V4.test(fields.eventId ?? '') ||
    (fields.clickId !== undefined && !OPAQUE_ID.test(fields.clickId))) {
    throw new InvalidRequest();
  }

  // Freeze attribution before the installer lookup or a delivery retry can run.
  return Object.freeze({
    installer: INSTALLERS[fields.platform],
    event: Object.freeze({
      event: DOWNLOAD_EVENT,
      eventId: fields.eventId,
      ...(fields.clickId === undefined ? {} : { clickId: fields.clickId }),
      test,
    }),
  });
}

async function bounded(work, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Download integration deadline exceeded.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function allowedAssetUrl(value, filename) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (url.hostname === 'release-assets.githubusercontent.com') return true;
    return url.hostname === 'github.com' && !url.search &&
      (url.pathname === `/Wardenlabs/warden/releases/latest/download/${filename}` ||
        (url.pathname.startsWith('/Wardenlabs/warden/releases/download/') &&
          url.pathname.endsWith(`/${filename}`)));
  } catch {
    return false;
  }
}

async function installerAvailable(installer, fetchImpl, signal) {
  const filename = installer.split('/').at(-1);
  let url = installer;
  // Inspect each redirect: a fixed starting URL alone does not constrain its destination.
  for (let hop = 0; hop < 6; hop++) {
    if (!allowedAssetUrl(url, filename)) return false;
    signal.throwIfAborted();
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) return false;
      url = new URL(location, url).href;
      continue;
    }
    if (response.status !== 200 || !response.ok ||
      (response.url && !allowedAssetUrl(response.url, filename))) return false;
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const size = response.headers.get('content-length');
    const attachment = response.headers.get('content-disposition')?.toLowerCase().startsWith('attachment');
    return (size === null || (/^\d+$/.test(size) && Number(size) > 0)) &&
      (['application/octet-stream', 'binary/octet-stream', 'application/x-apple-diskimage',
        'application/x-msdownload', 'application/vnd.microsoft.portable-executable'].includes(type) ||
        (attachment && type !== 'text/html'));
  }
  return false;
}

function respond(res, status, location) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (location) res.setHeader('Location', location);
  if (status === 405) res.setHeader('Allow', 'POST');
  if (status >= 400) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(status >= 400 ? 'Invalid download request.' : undefined);
}

/** Measures a validated download request for an available installer, not completed bytes or installation. */
export function createDownloadHandler({
  fetchImpl = globalThis.fetch,
  env = process.env,
  diagnose = (code, details) => console.info(`[kool] ${code}`, details ?? ''),
  assetTimeoutMs = 3000,
  deliveryTimeoutMs = 3500,
  requestTimeoutMs = 5000,
} = {}) {
  const diagnostic = (code, details) => {
    // Diagnostics contain only opaque operation/delivery IDs, never attribution or request data.
    try { diagnose(code, details); } catch { /* Download delivery remains independent of diagnostics. */ }
  };

  return async function download(req, res) {
    if (req.method !== 'POST') return respond(res, 405);
    let operation;
    try {
      operation = await operationFrom(req, requestTimeoutMs, env.VERCEL_ENV !== 'production');
    } catch (error) {
      return respond(res, error instanceof InvalidRequest ? error.status : 400);
    }

    // Bounded diagnostic headers make a missing deployment variable or rejected
    // delivery distinguishable without exposing credentials or request data.
    res.setHeader('X-Warden-Kool-Mode', operation.event.test ? 'test' : 'production');
    let available = false;
    try {
      available = await bounded((signal) => installerAvailable(operation.installer, fetchImpl, signal), assetTimeoutMs);
    } catch { /* The fixed release URL remains the fallback if verification is unavailable. */ }
    if (!available) {
      res.setHeader('X-Warden-Kool-Status', 'installer-unavailable');
      diagnostic('installer_unavailable');
      return respond(res, 303, operation.installer);
    }

    if (!env.KOOL_INGEST_TOKEN) {
      res.setHeader('X-Warden-Kool-Status', 'unconfigured');
      diagnostic('ingest_token_missing');
      return respond(res, 303, operation.installer);
    }
    try {
      await bounded(async (signal) => {
        const kool = createKoolClient({
          ingestToken: env.KOOL_INGEST_TOKEN,
          maxRetries: 1,
          fetch: (url, options) => {
            signal.throwIfAborted();
            return fetchImpl(url, { ...options, signal: AbortSignal.any([signal, options.signal]) });
          },
        });
        const delivery = await kool.track(operation.event);
        signal.throwIfAborted();
        res.setHeader('X-Warden-Kool-Status', delivery.status.toLowerCase());
        diagnostic('delivery_confirmed', {
          event: operation.event.event,
          eventId: operation.event.eventId,
          deliveryId: delivery.id,
          status: delivery.status,
          duplicate: delivery.duplicate,
          test: operation.event.test,
          hasAttribution: operation.event.clickId !== undefined,
        });
      }, deliveryTimeoutMs);
    } catch (error) {
      const httpStatus = error instanceof KoolApiError ? error.status : undefined;
      res.setHeader('X-Warden-Kool-Status', httpStatus ? `rejected-${httpStatus}` : 'unconfirmed');
      diagnostic('delivery_unconfirmed', httpStatus ? { httpStatus } : undefined);
    }
    return respond(res, 303, operation.installer);
  };
}
