/**
 * get_script_decisions, set_script_decisions, and what export_script says
 * about a script's provider after an agent's edit.
 *
 * The extension (1.4.0) decides every Script Decisions refusal. These pin the
 * MCP half: what each tool accepts and sends, that the extension's type and
 * code reach the caller untouched (the CLI exits on the type), and that an
 * extension built before the commands existed reads as outdated, not as a
 * fault. Handlers run inside the real tool envelope, which is what turns a
 * thrown error into the `structuredContent.error` a caller branches on.
 */

import { describe, it, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools, scriptDecisionsAfterEdit } from '../server.js';
import { installToolEnvelope } from '../tool-envelope.js';
import { EXIT, exitCodeForErrorType } from '../cli/exit-codes.js';

type Registered = { name: string; config: any; handler: (args: unknown, ctx: unknown) => Promise<any> };

function setup(dispatch: (tool: string, args: Record<string, unknown>) => Promise<unknown>) {
  const tools: Registered[] = [];
  const server = {
    registerTool: (name: string, config: unknown, handler: Registered['handler']) => { tools.push({ name, config, handler }); },
  };
  installToolEnvelope(server);
  const bridge = {
    dispatchTool: mock.fn(dispatch),
    onPush: () => {},
    getSystemStatus: () => null,
    getSessionSnapshot: () => ({}),
  };
  registerTools(server as any, bridge as any);
  const tool = (name: string): Registered => {
    const found = tools.find((t) => t.name === name);
    assert.ok(found, `${name} is not registered`);
    return found!;
  };
  return { bridge, tool, call: (name: string, args: Record<string, unknown>) => tool(name).handler(args, {}) };
}

const HASH = 'a'.repeat(64);
const ARGS: Record<string, Record<string, unknown>> = {
  get_script_decisions: { scriptId: 's1' },
  set_script_decisions: { scriptId: 's1', provider: 'jev' },
};
const VIEW = {
  available: true,
  agentAccess: { fullAccess: true, scriptDecisions: true, locked: false },
  signedIn: true, tier: 'power_user', deviceEnabled: true, locallyPaused: false,
  providers: [{ provider: 'jev', keySaved: true }],
  scripts: [{ scriptId: 's1', name: 'Probe', enabled: true, provider: 'jev', state: 'ready', chosenByAgent: true,
    sets: [{ hash: HASH, enabled: true, questions: [{ type: 'predicate', name: 'needs_reply', instructions: 'x', options: [] }] }],
    issues: [], rowsToday: 3 }],
};

describe('Script Decisions tools', () => {
  it('declare a read, and a change that is neither destructive nor repeated by a retry', () => {
    const { tool } = setup(async () => ({}));
    assert.deepEqual(tool('get_script_decisions').config.annotations,
      { title: 'Get Script Decisions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(tool('set_script_decisions').config.annotations,
      { title: 'Set Script Decisions', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it('tell an agent what needs the person, what stays with them, and not to retry person_required', () => {
    const { tool } = setup(async () => ({}));
    const get = tool('get_script_decisions').config.description as string;
    const set = tool('set_script_decisions').config.description as string;
    assert.match(get, /Use it before set_script_decisions/);
    assert.match(set, /needs the person to have turned on Script Decisions under Full access in Customaise Settings, Agent permissions/);
    assert.match(set, /Switching a script off is always allowed/);
    assert.match(set, /resumes a script the loop guard paused for repeating the same input/);
    for (const kept of ['provider keys', "this device's Allow Script Decisions switch", 'daily limits', 'pausing this device',
      'a script paused for a runaway loop (loop_runaway)', 'scripts shared with them']) {
      assert.ok(set.includes(kept), `set_script_decisions does not say "${kept}" stays with the person`);
    }
    assert.match(set, /When the error type is person_required, tell the person the next step the message names and do not retry/);
    assert.match(set, /After service_unavailable or a timeout the outcome is uncertain: read the state with get_script_decisions/);
    for (const text of [get, set]) {
      assert.match(text, /Needs extension 1\.4\.0 or later/);
      assert.doesNotMatch(text, /—/);
    }
  });

  it('validate their arguments before anything is dispatched', () => {
    const { tool } = setup(async () => ({}));
    const get = tool('get_script_decisions').config.inputSchema;
    for (const ok of [{}, { scriptId: 's1' }]) assert.equal(get.safeParse(ok).success, true, JSON.stringify(ok));
    for (const bad of [{ scriptId: '' }, { scriptId: 7 }, { scriptId: 'x'.repeat(129) }]) {
      assert.equal(get.safeParse(bad).success, false, JSON.stringify(bad));
    }
    const set = tool('set_script_decisions').config.inputSchema;
    for (const ok of [
      { scriptId: 's1', provider: 'jev' },
      { scriptId: 's1', provider: 'openai-decisions', sets: [HASH] },
      { scriptId: 's1', provider: 'jev', sets: [] },
      { scriptId: 's1', provider: 'off' },
    ]) assert.equal(set.safeParse(ok).success, true, JSON.stringify(ok));
    for (const bad of [
      { provider: 'jev' },
      { scriptId: 's1' },
      { scriptId: 's1', provider: 'gpt' },
      { scriptId: 's1', provider: null },
      { scriptId: 's1', provider: 'jev', sets: 'all' },
      { scriptId: 's1', provider: 'jev', sets: ['A'.repeat(64)] },
      { scriptId: 's1', provider: 'jev', sets: ['abc'] },
      { scriptId: 's1', provider: 'jev', sets: Array(201).fill(HASH) },
    ]) assert.equal(set.safeParse(bad).success, false, JSON.stringify(bad));
  });

  it('refuse question lists with off as a usage error, without a dispatch', async () => {
    const s = setup(async () => ({}));
    const out = await s.call('set_script_decisions', { scriptId: 's1', provider: 'off', sets: [HASH] });
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.error.type, 'invalid_argument');
    assert.equal(exitCodeForErrorType(out.structuredContent.error.type), EXIT.USAGE);
    assert.equal(s.bridge.dispatchTool.mock.callCount(), 0);
  });

  it('dispatch exactly the arguments the extension reads', async () => {
    const s = setup(async () => VIEW);
    await s.call('get_script_decisions', {});
    await s.call('get_script_decisions', { scriptId: 's1' });
    await s.call('set_script_decisions', { scriptId: 's1', provider: 'jev' });
    await s.call('set_script_decisions', { scriptId: 's1', provider: 'openai-decisions', sets: [HASH] });
    await s.call('set_script_decisions', { scriptId: 's1', provider: 'jev', sets: [] });
    await s.call('set_script_decisions', { scriptId: 's1', provider: 'off' });
    assert.deepEqual(s.bridge.dispatchTool.mock.calls.map((c) => c.arguments), [
      ['get_script_decisions', {}],
      ['get_script_decisions', { scriptId: 's1' }],
      ['set_script_decisions', { scriptId: 's1', provider: 'jev' }],
      ['set_script_decisions', { scriptId: 's1', provider: 'openai-decisions', sets: [HASH] }],
      ['set_script_decisions', { scriptId: 's1', provider: 'jev', sets: [] }],
      ['set_script_decisions', { scriptId: 's1', provider: 'off' }],
    ]);
  });

  it('return the extension view whole, in both halves', async () => {
    const s = setup(async () => VIEW);
    for (const name of Object.keys(ARGS)) {
      const out = await s.call(name, ARGS[name]);
      assert.equal(out.isError, undefined);
      assert.deepEqual(out.structuredContent, VIEW);
      assert.deepEqual(JSON.parse(out.content[0].text), VIEW);
    }
  });

  it('pass every refusal type and code through untouched, so the CLI exits on it', async () => {
    const cases: Array<[string, string, number]> = [
      ['person_required', 'agent_access_off', EXIT.DENIED],
      ['person_required', 'key_unavailable', EXIT.DENIED],
      ['person_required', 'shared_script', EXIT.DENIED],
      ['rejected', 'stale_view', EXIT.REJECTED],
      ['not_found', 'script_unavailable', EXIT.REJECTED],
      ['auth_required', 'authentication_required', EXIT.AUTH],
      ['invalid_argument', 'invalid_request', EXIT.USAGE],
      ['service_unavailable', 'connection_uncertain', EXIT.UNAVAILABLE],
    ];
    for (const [type, code, exit] of cases) {
      const message = `Refused (${code}).`;
      const s = setup(async () => { throw Object.assign(new Error(message), { data: { type, code } }); });
      for (const name of Object.keys(ARGS)) {
        const out = await s.call(name, ARGS[name]);
        assert.equal(out.isError, true);
        assert.deepEqual(out.structuredContent.error, { type, code, message }, `${name}: ${type}/${code}`);
        assert.equal(out.content[0].text, message);
        assert.equal(exitCodeForErrorType(out.structuredContent.error.type), exit);
      }
    }
  });

  it('report an extension before 1.4.0 as outdated, naming the version that has the command', async () => {
    for (const name of Object.keys(ARGS)) {
      const s = setup(async (tool) => { throw new Error(`Unknown MCP request type: ${tool}`); });
      const out = await s.call(name, ARGS[name]);
      assert.equal(out.isError, true);
      assert.equal(out.structuredContent.error.type, 'extension_outdated');
      assert.equal(out.structuredContent.error.minExtensionVersion, '1.4.0');
      assert.equal(out.structuredContent.error.command, name);
      assert.match(out.content[0].text, new RegExp(`^${name} needs Customaise 1\\.4\\.0 or later`));
      assert.match(out.content[0].text, /update the extension from chrome:\/\/extensions/);
      assert.equal(exitCodeForErrorType(out.structuredContent.error.type), EXIT.UNAVAILABLE);
    }
  });

  it('leave every other failure as it was', async () => {
    // Another command's name, a typed error that happens to read the same,
    // and a message that only contains the phrase are none of them this case.
    const failures: Array<[unknown, string]> = [
      [new Error('Unknown MCP request type: something_else'), 'internal_error'],
      [Object.assign(new Error('Unknown MCP request type: get_script_decisions'), { data: { type: 'rejected' } }), 'rejected'],
      [new Error('Leader relayed: Unknown MCP request type: get_script_decisions'), 'internal_error'],
    ];
    for (const [error, type] of failures) {
      const s = setup(async () => { throw error; });
      const out = await s.call('get_script_decisions', {});
      assert.equal(out.structuredContent.error.type, type);
      assert.equal(out.content[0].text, (error as Error).message);
    }
  });
});

describe('export_script reports the script provider after an edit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'customaise-decisions-export-'));
  const file = join(dir, 'probe.user.js');
  writeFileSync(file, '// ==UserScript==\n// @name Probe\n// @grant CM_decisions\n// ==/UserScript==\n', 'utf-8');
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('puts one line above the JSON, and the same sentence in structuredContent', async () => {
    const saved = { success: true, scriptId: 's1', name: 'Probe', warnings: [], scriptDecisions: { provider: 'jev', kept: true } };
    const s = setup(async () => saved);
    const out = await s.call('export_script', { filePath: file, scriptId: 's1' });
    const line = 'Script Decisions: Jev stays chosen for the new code.';
    const text: string = out.content[0].text;
    assert.equal(text.split('\n')[0], line);
    // The JSON below the line is still the extension's own result.
    assert.deepEqual(JSON.parse(text.slice(text.indexOf('{'))), saved);
    assert.deepEqual(out.structuredContent, { ...saved, scriptDecisions: { provider: 'jev', kept: true, message: line } });
  });

  it('says what to do when the provider was not kept', async () => {
    const s = setup(async () => ({ success: true, scriptId: 's1',
      scriptDecisions: { provider: 'openai-decisions', kept: false, reason: 'agent_access_off' } }));
    const out = await s.call('export_script', { filePath: file, scriptId: 's1' });
    assert.match(out.content[0].text, /^Script Decisions: Decisions API was not kept for the new code: Script Decisions is not turned on for agents, so the person chooses the provider again in the script's Decisions menu\./);
    assert.equal(out.structuredContent.scriptDecisions.reason, 'agent_access_off');
    assert.match(out.structuredContent.scriptDecisions.message, /the person chooses the provider again/);
  });

  it('adds nothing for a script with nothing to report', async () => {
    const saved = { success: true, scriptId: 's1', name: 'Probe' };
    const s = setup(async () => saved);
    const out = await s.call('export_script', { filePath: file, scriptId: 's1' });
    assert.deepEqual(JSON.parse(out.content[0].text), saved);
    assert.deepEqual(out.structuredContent, saved);
  });

  it('describes every outcome the extension reports, without em dashes', () => {
    const line = (value: unknown) => scriptDecisionsAfterEdit(value) ?? '';
    const cases: Array<[unknown, RegExp]> = [
      [{ provider: 'openai-decisions', kept: true }, /^Script Decisions: Decisions API stays chosen for the new code\.$/],
      [{ provider: null, kept: false, reason: 'no_provider' }, /no provider is chosen for this script yet/],
      [{ provider: 'jev', kept: false, reason: 'permission_mode_changed' }, /not turned on for agents, so the person chooses the provider again/],
      [{ provider: 'jev', kept: false, reason: 'paused', pausedReason: 'loop_repeat' },
        /repeating the same input\. Choosing the provider again with set_script_decisions resumes it/],
      [{ provider: 'jev', kept: false, reason: 'paused', pausedReason: 'loop_runaway' },
        /paused for a runaway loop\. Only the person can resume it, from the script's Decisions menu/],
      [{ provider: 'jev', kept: false, reason: 'paused', pausedReason: null }, /the script is paused\. Only the person can resume it/],
      [{ provider: 'jev', kept: false, reason: 'device_changed' }, /this device's Script Decisions access changed/],
      [{ provider: 'jev', kept: false, reason: 'not_current' }, /already waiting to be chosen again before this edit/],
      [{ provider: 'jev', kept: false, reason: 'script_unavailable' }, /the script is turned off\. Turn it on/],
      [{ provider: 'jev', kept: false, reason: 'declaration_required' }, /question lists have problems\. get_script_decisions lists them/],
      [{ provider: 'jev', kept: false, reason: 'version_held' },
        /the version the person holds for this script cannot answer its new questions\. Only they can choose another, in the script's Decisions menu/],
      [{ provider: 'openai-decisions', kept: false, reason: 'version_unsupported' },
        /no version of Decisions API answers the new questions\. Choose another provider with set_script_decisions/],
      [{ provider: 'jev', kept: false, reason: 'connection_uncertain' }, /could not confirm whether the provider was kept for the new code\. Check/],
      [{ kept: false, reason: 'connection_uncertain' }, /could not confirm whether the provider was kept for the new code\. Check/],
      [{ kept: false, reason: 'authentication_required' }, /could not confirm .* \(authentication_required\)\. Check with get_script_decisions/],
      [{ provider: 'jev', kept: false, reason: 'something_new' }, /Jev was not kept for the new code \(something_new\)\. Check with get_script_decisions/],
    ];
    for (const [value, expected] of cases) {
      const text = line(value);
      assert.match(text, expected, JSON.stringify(value));
      assert.doesNotMatch(text, /—/);
      assert.doesNotMatch(text, /\bthe user\b/);
    }
    for (const nothing of [null, undefined, 'kept', [], 7]) assert.equal(scriptDecisionsAfterEdit(nothing), null);
  });
});
