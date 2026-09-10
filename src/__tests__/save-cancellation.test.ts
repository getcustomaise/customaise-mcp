import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = '1';
process.env.CUSTOMAISE_MCP_DISPATCH_TIMEOUT_MS = '350';
const { ExtensionBridge } = await import('../extension-bridge.js');
const { RemoteBridge } = await import('../remote-bridge.js');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await wait(10); }
  throw new Error('Expected bridge frame did not arrive');
}
async function setup(t: any) {
  const leader = new ExtensionBridge(0, 500);
  await leader.start();
  const port = (leader as any).wss.address().port;
  const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko' });
  const frames: any[] = [];
  ext.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  await new Promise<void>((resolve, reject) => { ext.on('open', resolve); ext.on('error', reject); });
  ext.send(JSON.stringify({ type: 'init_session', session_id: 'save-tests', install_id: 'test', tier: 'power_user', unlimited: true, authenticated: true }));
  await until(() => leader.getSessionSnapshot().capMode === 'unlimited');
  t.after(async () => { ext.terminate(); await leader.close(); });
  return { leader, ext, frames, port };
}

it('the leader timeout sends cancellation with the same dispatch identity', async t => {
  const { leader, frames } = await setup(t);
  const result = leader.dispatchTool('export_script', { scriptId: 's1', saveOperationId: 'op1' }).catch(error => error);
  const error = await result as any;
  await until(() => frames.some(frame => frame.type === 'cancel_dispatch'));
  const dispatch = frames.find(frame => frame.type === 'dispatch_tool');
  const cancel = frames.find(frame => frame.type === 'cancel_dispatch');
  assert.equal(cancel.seq_num, dispatch.seq_num);
  assert.equal(cancel.session_id, dispatch.session_id);
  assert.equal(error.data.outcome, 'unknown');
  assert.equal(error.data.operationId, 'op1');
  assert.doesNotMatch(error.message, /reload the target tab/);
});

it('caller cancellation crosses a follower and closes only its owned dispatch', async t => {
  const { leader, ext, frames, port } = await setup(t);
  const follower = new RemoteBridge(port, 2000);
  const other = new RemoteBridge(port, 2000);
  await follower.start(); await other.start();
  t.after(async () => { await follower.close(); await other.close(); });
  await until(() => follower.getSessionSnapshot().extensionConnected && other.getSessionSnapshot().extensionConnected);
  const abort = new AbortController();
  const result = follower.dispatchTool('export_script', { scriptId: 's1' }, { signal: abort.signal }).catch(error => error);
  await until(() => frames.some(frame => frame.type === 'dispatch_tool'));
  const dispatch = frames.find(frame => frame.type === 'dispatch_tool');
  ext.send(JSON.stringify({ type: 'dispatch_tool_pending', session_id: 'save-tests', seq_num: dispatch.seq_num,
    expected_timeout_ms: 2000, reason: 'script_save:monaco_document_setup (op)' }));
  const pending = [...(leader as any).dispatchPending.values()][0] as any;
  (other as any).ws.send(JSON.stringify({ role: 'req-cancel', id: pending.followerOrigId }));
  await wait(30);
  assert.equal(frames.filter(frame => frame.type === 'cancel_dispatch').length, 0);
  abort.abort();
  assert.equal((await result as any).data.type, 'dispatch_cancelled');
  await until(() => frames.some(frame => frame.type === 'cancel_dispatch'));
  assert.equal(frames.find(frame => frame.type === 'cancel_dispatch').seq_num, dispatch.seq_num);
  assert.equal((leader as any).dispatchPending.size, 0);
});

it('follower timeout cancels the leader instead of abandoning its save', async t => {
  const { frames, port } = await setup(t);
  const follower = new RemoteBridge(port, 80);
  await follower.start(); t.after(() => follower.close());
  await until(() => follower.getSessionSnapshot().extensionConnected);
  const error: any = await follower.dispatchTool('export_script', { scriptId: 's1' }).catch(error => error);
  assert.equal(error.data.type, 'dispatch_timeout');
  await until(() => frames.some(frame => frame.type === 'cancel_dispatch'));
});

it('expired progress timeout also cancels the original dispatch', async t => {
  const { leader, ext, frames } = await setup(t);
  const result = leader.dispatchTool('export_script', { scriptId: 's1' }).catch(error => error);
  await until(() => frames.some(frame => frame.type === 'dispatch_tool'));
  const dispatch = frames.find(frame => frame.type === 'dispatch_tool');
  ext.send(JSON.stringify({ type: 'dispatch_tool_pending', session_id: 'save-tests', seq_num: dispatch.seq_num,
    expected_timeout_ms: 400, reason: 'script_save:icons (op)' }));
  assert.equal((await result as any).data.type, 'dispatch_timeout');
  await until(() => frames.some(frame => frame.type === 'cancel_dispatch'));
});

it('save status crosses an exhausted quota without opening an integrity bypass', async t => {
  const { leader, ext, frames } = await setup(t);
  ext.send(JSON.stringify({ type: 'init_session', session_id: 'save-tests', install_id: 'test', tier: 'free',
    authenticated: true, daily_cap: 50, weekly_cap: 150, current_used_daily: 50, current_used_week: 50 }));
  await until(() => leader.getSessionSnapshot().dailyUsed === 50);
  await assert.rejects(() => leader.dispatchTool('list_scripts'), /cap reached/);
  const result = leader.dispatchTool('get_script_save_status', { scriptId: 's1', operationId: 'op' });
  await until(() => frames.some(frame => frame.tool === 'get_script_save_status'));
  const frame = frames.find(frame => frame.tool === 'get_script_save_status');
  ext.send(JSON.stringify({ type: 'dispatch_ack', session_id: frame.session_id, seq_num: frame.seq_num,
    success: true, counter: 50, result: { outcome: 'committed' } }));
  assert.deepEqual(await result, { outcome: 'committed' });
  assert.equal(leader.getSessionSnapshot().dailyUsed, 50);
  (leader as any).capSession.mode = 'compromised';
  await assert.rejects(() => leader.dispatchTool('get_script_save_status', { scriptId: 's1' }), /integrity/i);
});
