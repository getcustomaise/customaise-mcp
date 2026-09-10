import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemonHttpHandler, WORKSPACE_HEADER, DAEMON_HTTP_LIMITS, workspaceHeaders, WORKSPACE_ENCODING_HEADER } from '../daemon-http.js';
import { currentRequestContext } from '../request-context.js';
import { getWorkspaceDir } from '../server.js';

const headers = { 'x-test-token': 'secret', [WORKSPACE_HEADER]: '/caller' };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t: TestContext, handler: (req: Request) => Promise<Response>, limits: Partial<typeof DAEMON_HTTP_LIMITS> = {}) {
  const workspaces = new Map<string, number>();
  const server = http.createServer(createDaemonHttpHandler({
    authorize: (req) => req.headers['x-test-token'] === 'secret',
    fetch: handler, activeWorkspaces: workspaces, limits,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`;
  const call = (body = '{}', customHeaders = headers) => fetch(url, { method: 'POST', body, headers: customHeaders, signal: AbortSignal.timeout(3000) });
  return { url, call, workspaces };
}

it('rejects an unauthorized unfinished upload before waiting for its body', async (t) => {
  let called = false;
  const { url } = await fixture(t, async () => { called = true; return new Response(); });
  const req = http.request(url, { method: 'POST', headers: { 'content-length': '999999999' } });
  req.on('error', () => {});
  req.flushHeaders(); // Deliberately never end or send the declared body.
  t.after(() => req.destroy());
  const [res] = await once(req, 'response');
  assert.equal(res.statusCode, 401);
  res.resume();
  assert.equal(called, false);
});

it('requires an absolute workspace on every request, including after a successful caller', async (t) => {
  let calls = 0;
  const { call, workspaces } = await fixture(t, async () => { calls++; return Response.json({ workspace: getWorkspaceDir() }); });
  assert.equal((await (await call()).json()).workspace, '/caller');
  for (const workspace of [undefined, '', 'relative/project']) {
    const h: Record<string, string> = { 'x-test-token': 'secret' };
    if (workspace !== undefined) h[WORKSPACE_HEADER] = workspace;
    const res = await call('{}', h as typeof headers);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).outcome, 'not_dispatched');
  }
  assert.equal(calls, 1);
  assert.deepEqual([...workspaces.keys()], ['/caller']);
});

it('keeps workspaces and signals isolated across concurrent asynchronous handlers', async (t) => {
  const started = deferred();
  const { call } = await fixture(t, async () => {
    const workspace = getWorkspaceDir();
    const signal = currentRequestContext().signal;
    if (workspace === '/a') await started.promise;
    else started.resolve();
    await delay(5);
    assert.equal(getWorkspaceDir(), workspace);
    assert.equal(currentRequestContext().signal, signal);
    return Response.json({ workspace });
  });
  const results = await Promise.all(['/a', '/b'].map(async (dir) => (await call('{}', { ...headers, [WORKSPACE_HEADER]: dir })).json()));
  assert.deepEqual(results, [{ workspace: '/a' }, { workspace: '/b' }]);
});

it('rejects declared and chunked oversized bodies before dispatch, then admits a valid request', async (t) => {
  let calls = 0;
  const { url, call } = await fixture(t, async () => { calls++; return new Response('ok'); }, { requestBytes: 8 });
  assert.equal((await call('123456789')).status, 413);
  const req = http.request(url, { method: 'POST', headers });
  req.on('error', () => {});
  const response = once(req, 'response');
  req.write('12345');
  req.end('67890');
  const [res] = await response;
  assert.equal(res.statusCode, 413);
  res.resume();
  assert.equal(await (await call()).text(), 'ok');
  assert.equal(calls, 1);
});

it('times out stalled uploads and releases their admission slots', async (t) => {
  const { url, call } = await fixture(t, async () => new Response('ok'), { bodyTimeoutMs: 40, concurrentRequests: 1 });
  const req = http.request(url, { method: 'POST', headers: { ...headers, 'content-length': '10' } });
  req.on('error', () => {});
  req.flushHeaders();
  t.after(() => req.destroy());
  const [res] = await once(req, 'response');
  assert.equal(res.statusCode, 408);
  res.resume();
  assert.equal(await (await call()).text(), 'ok');
});

it('streams pending progress immediately, limits concurrency and cancels on disconnect', async (t) => {
  const cancelled = deferred();
  let signal: AbortSignal | undefined;
  let first = true;
  const { call, url } = await fixture(t, async (req) => {
    if (!first) return new Response('ok');
    first = false;
    signal = req.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: pending\n\n')); },
      cancel() { cancelled.resolve(); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }, { concurrentRequests: 1 });
  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(url, { method: 'POST', body: '{}', headers, signal: ac.signal });
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: pending\n\n');
  assert.equal((await call()).status, 429);
  ac.abort();
  await cancelled.promise;
  assert.equal(signal?.aborted, true);
  await delay(10);
  assert.equal(await (await call()).text(), 'ok');
});

it('fails an oversized response and cancels its producer instead of truncating success', async (t) => {
  const cancelled = deferred();
  const { call } = await fixture(t, async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(9)); },
    cancel() { cancelled.resolve(); },
  })), { responseBytes: 8 });
  await assert.rejects(async () => (await call()).text());
  await cancelled.promise;
});

it('reports an unknown outcome for a declared oversized response after dispatch', async (t) => {
  const { call } = await fixture(t, async () => new Response('123456789', { headers: { 'content-length': '9' } }), { responseBytes: 8 });
  const res = await call();
  assert.equal(res.status, 502);
  assert.match((await res.json()).outcome, /unknown/);
});

it('expires workspace history and refuses excess active entries without evicting another caller', async (t) => {
  const { call, workspaces } = await fixture(t, async () => new Response('ok'), { activeWorkspaces: 1 });
  workspaces.set('/expired', 0);
  assert.equal((await call()).status, 200);
  assert.equal((await call('{}', { ...headers, [WORKSPACE_HEADER]: '/other' })).status, 429);
  assert.deepEqual([...workspaces.keys()], ['/caller']);
});

it('aborts an unfinished response at the request deadline and releases capacity', async (t) => {
  const cancelled = deferred();
  let first = true;
  const { call } = await fixture(t, async () => {
    if (!first) return new Response('ok');
    first = false;
    return new Response(new ReadableStream({ cancel() { cancelled.resolve(); } }));
  }, { requestTimeoutMs: 50, concurrentRequests: 1 });
  await assert.rejects(async () => (await call()).text());
  await cancelled.promise;
  assert.equal(await (await call()).text(), 'ok');
});

it('decodes explicitly encoded Unicode paths once and preserves literal percent escapes', async (t) => {
  const { call } = await fixture(t, async () => Response.json({ workspace: getWorkspaceDir() }));
  for (const workspace of ['/tmp/日本語/50% done/%2F', '/tmp/literal%2F']) {
    const res = await call('{}', { ...headers, ...workspaceHeaders(workspace, true) });
    assert.equal((await res.json()).workspace, workspace);
  }
  assert.equal((await call('{}', { ...headers, [WORKSPACE_HEADER]: '/literal%2F' }).then(r => r.json())).workspace, '/literal%2F');
  for (const workspace of ['%GG', '%00', 'relative']) {
    assert.equal((await call('{}', { ...headers, [WORKSPACE_HEADER]: workspace, [WORKSPACE_ENCODING_HEADER]: 'uri' } as typeof headers)).status, 400);
  }
  assert.throws(() => workspaceHeaders('/tmp/日本語', false), /daemon stop/);
  assert.deepEqual(workspaceHeaders('/tmp/legacy%20', false), { [WORKSPACE_HEADER]: '/tmp/legacy%20' });
});

it('applies backpressure to a producer while the HTTP reader is paused', { timeout: 5000 }, async (t) => {
  const cancelled = deferred();
  let producedBytes = 0;
  const { url } = await fixture(t, async () => new Response(new ReadableStream({
    pull(controller) {
      producedBytes += 256 * 1024;
      controller.enqueue(new Uint8Array(256 * 1024));
    },
    cancel() { cancelled.resolve(); },
  })), { responseBytes: 256 * 1024 * 1024 });
  const req = http.request(url, { method: 'POST', headers });
  req.on('error', () => {});
  const response = once(req, 'response');
  req.end('{}');
  const [res] = await response;
  res.pause();
  t.after(() => req.destroy());
  await delay(50);
  assert.ok(producedBytes < 32 * 1024 * 1024, `paused reader allowed ${producedBytes} bytes to be produced`);
  req.destroy();
  await cancelled.promise;
});

it('retains admission for a handler that ignores cancellation until the work settles', { timeout: 5000 }, async (t) => {
  const release = deferred();
  const started = deferred();
  let first = true;
  const { url, call } = await fixture(t, async () => {
    if (first) {
      first = false;
      started.resolve();
      await release.promise;
    }
    return new Response('ok');
  }, { requestTimeoutMs: 40, concurrentRequests: 1 });
  const ac = new AbortController();
  const waiting = fetch(url, { method: 'POST', body: '{}', headers, signal: ac.signal }).catch(() => null);
  t.after(() => { ac.abort(); release.resolve(); });
  await started.promise;
  const timedOut = await waiting;
  assert.equal(timedOut?.status, 504, 'HTTP timeout must arrive before ignored work is released');
  assert.equal((await call()).status, 429);
  release.resolve();
  await delay(10);
  assert.equal(await (await call()).text(), 'ok');
});

it('releases an upload slot when a client disconnects before completing its body', { timeout: 5000 }, async (t) => {
  let calls = 0;
  const { url, call } = await fixture(t, async () => { calls++; return new Response('ok'); }, { concurrentRequests: 1 });
  const req = http.request(url, { method: 'POST', headers: { ...headers, 'content-length': '100' } });
  req.on('error', () => {});
  req.write('partial');
  t.after(() => req.destroy());
  await delay(20);
  assert.equal((await call()).status, 429);
  req.destroy();
  await delay(20);
  assert.equal(await (await call()).text(), 'ok');
  assert.equal(calls, 1);
});
