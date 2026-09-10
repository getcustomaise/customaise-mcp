/** Bounded loopback HTTP adapter shared by the CLI and custom MCP clients. */
import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import { isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { withRequestContext } from './request-context.js';
import { WORKSPACE_ACTIVE_MS } from './push-target.js';

export const WORKSPACE_HEADER = 'x-customaise-workspace';
export const WORKSPACE_ENCODING_HEADER = 'x-customaise-workspace-encoding';

/** New daemons advertise this encoding in daemon.json before the CLI uses it. */
export function workspaceHeaders(workspace: string, uriSupported: boolean): Record<string, string> {
  if (uriSupported) return {
    [WORKSPACE_HEADER]: encodeURIComponent(workspace),
    [WORKSPACE_ENCODING_HEADER]: 'uri',
  };
  if (/[^\x20-\x7e]/.test(workspace)) {
    throw new Error('This daemon cannot encode this workspace path. Run customaise daemon stop, then retry with the updated CLI.');
  }
  return { [WORKSPACE_HEADER]: workspace };
}
export const DAEMON_HTTP_LIMITS = {
  requestBytes: 8 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  concurrentRequests: 16,
  activeWorkspaces: 256,
  bodyTimeoutMs: 30_000,
  requestTimeoutMs: 10 * 60_000,
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function readBody(req: IncomingMessage, signal: AbortSignal, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (err?: Error) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      req.pause();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(new HttpError(413, 'request_too_large', `Request exceeds ${maxBytes} bytes; no tool was dispatched.`));
      } else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (err: Error) => finish(err);
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new HttpError(408, 'upload_timeout', 'Request body timed out; no tool was dispatched.')), timeoutMs);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

interface HttpHandlerOptions {
  authorize: (req: IncomingMessage) => boolean;
  fetch: (request: Request) => Promise<Response>;
  activeWorkspaces: Map<string, number>;
  onActivity?: () => void;
  limits?: Partial<typeof DAEMON_HTTP_LIMITS>;
}

export function createDaemonHttpHandler(options: HttpHandlerOptions): RequestListener {
  const limits = { ...DAEMON_HTTP_LIMITS, ...options.limits };
  let activeRequests = 0;
  return async (req, res) => {
    let admitted = false;
    let dispatched = false;
    const ac = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) ac.abort(new Error('HTTP client disconnected'));
    };
    req.once('aborted', onClientGone);
    res.once('close', onClientGone);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Authenticate before allocating an upload buffer or an admission slot.
      if (!options.authorize(req)) throw new HttpError(401, 'unauthorized', 'Invalid daemon token.');
      let workspace = req.headers[WORKSPACE_HEADER];
      const encoding = req.headers[WORKSPACE_ENCODING_HEADER];
      if (encoding !== undefined) {
        if (encoding !== 'uri' || typeof workspace !== 'string') {
          throw new HttpError(400, 'invalid_workspace', 'Unsupported workspace header encoding; no tool was dispatched.');
        }
        try { workspace = decodeURIComponent(workspace); }
        catch { throw new HttpError(400, 'invalid_workspace', 'Malformed workspace URI; no tool was dispatched.'); }
      }
      if (typeof workspace !== 'string' || !isAbsolute(workspace) || /[\x00-\x1f\x7f]/.test(workspace)) {
        throw new HttpError(400, 'invalid_workspace', `Send an absolute ${WORKSPACE_HEADER} on every request; no tool was dispatched.`);
      }
      if (activeRequests >= limits.concurrentRequests) {
        throw new HttpError(429, 'daemon_busy', 'Daemon request limit reached; no tool was dispatched.');
      }
      const length = req.headers['content-length'];
      if (length !== undefined && Number(length) > limits.requestBytes) {
        throw new HttpError(413, 'request_too_large', `Request exceeds ${limits.requestBytes} bytes; no tool was dispatched.`);
      }
      admitted = true;
      activeRequests++;
      options.onActivity?.();
      deadline = setTimeout(() => {
        const error = new HttpError(504, 'request_timeout', 'Daemon request timed out.');
        ac.abort(error);
        // End the HTTP wait even if a handler ignores abort. Its admission
        // slot stays occupied until fetch/pipeline actually settles below.
        respondError(res, error, dispatched);
      }, limits.requestTimeoutMs);
      const body = await readBody(req, ac.signal, limits.requestBytes, limits.bodyTimeoutMs);
      const now = Date.now();
      for (const [dir, seen] of options.activeWorkspaces) {
        if (seen < now - WORKSPACE_ACTIVE_MS) options.activeWorkspaces.delete(dir);
      }
      if (!options.activeWorkspaces.has(workspace) && options.activeWorkspaces.size >= limits.activeWorkspaces) {
        throw new HttpError(429, 'workspace_limit', 'Too many recently active workspaces; no tool was dispatched.');
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request('http://127.0.0.1:' + req.socket.localPort + (req.url ?? '/'), {
        method: req.method,
        headers,
        body: body.length ? new Uint8Array(body) : undefined,
        signal: ac.signal,
      });
      options.activeWorkspaces.set(workspace, now);
      dispatched = true;
      const out = await withRequestContext(
        { workspaceDir: workspace, signal: ac.signal },
        () => options.fetch(request),
      );
      if (ac.signal.aborted) {
        void out.body?.cancel(ac.signal.reason).catch(() => {});
        throw ac.signal.reason;
      }
      if (Number(out.headers.get('content-length')) > limits.responseBytes) {
        void out.body?.cancel().catch(() => {});
        throw new HttpError(502, 'response_too_large', 'Daemon response exceeds its byte limit.');
      }
      res.writeHead(out.status, Object.fromEntries(out.headers));
      if (!out.body) { res.end(); return; }
      // pipeline applies socket backpressure and cancels the Web stream on
      // disconnect/error. SSE progress must reach callers before completion.
      let sent = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sent += chunk.length;
          if (sent > limits.responseBytes) {
            callback(new HttpError(502, 'response_too_large', 'Daemon response exceeds its byte limit.'));
          } else callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(out.body as Parameters<typeof Readable.fromWeb>[0]), bounded, res, { signal: ac.signal });
    } catch (err) {
      ac.abort(err);
      respondError(res, err, dispatched);
    } finally {
      clearTimeout(deadline);
      req.off('aborted', onClientGone);
      res.off('close', onClientGone);
      if (admitted) activeRequests--;
    }
  };
}

function respondError(res: ServerResponse, err: unknown, dispatched: boolean): void {
  if (res.destroyed || res.writableEnded) return;
  // Once streaming has started a transport failure must remain a failure,
  // never append an error object to a successful JSON/SSE result.
  if (res.headersSent) { res.destroy(); return; }
  const failure = err instanceof HttpError ? err : new HttpError(500, 'daemon_error', 'Daemon request failed.');
  res.writeHead(failure.status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({
    error: failure.code,
    message: failure.message,
    outcome: dispatched ? 'unknown; check the result before retrying a mutating tool' : 'not_dispatched',
  }));
}
