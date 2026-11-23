import { it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  SCRIPT_DECISIONS_CONVENTIONS,
  SCRIPT_DECISIONS_AGENT_EXAMPLE,
  SCRIPT_DECISIONS_EXAMPLE,
  SCRIPT_DECISIONS_QUESTIONS,
} from '../script-decisions-guide.js';
import { SERVER_INSTRUCTIONS } from '../build-server.js';
import { buildPrimer } from '../cli/primer.js';

it('the shipped example grants CM_decisions and has no @decisions header', () => {
  assert.match(SCRIPT_DECISIONS_EXAMPLE, /^\/\/ @grant CM_decisions$/m);
  assert.doesNotMatch(SCRIPT_DECISIONS_EXAMPLE, /@decisions/);
  assert.match(SCRIPT_DECISIONS_CONVENTIONS, /CM_decisions\.createMany/);
});

async function runExample(reply: () => Promise<Record<string, unknown>>) {
  const calls: Array<Record<string, unknown>> = [];
  let handler: (() => Promise<void>) | undefined;
  const elements: Array<{
    textContent: string;
    disabled?: boolean;
    addEventListener: (event: string, fn: () => Promise<void>, options?: unknown) => void;
  }> = [];
  const context = vm.createContext({
    document: {
      body: { append() {} },
      createElement: () => {
        const element = {
          textContent: '',
          addEventListener: (_: string, fn: () => Promise<void>) => {
            handler = fn;
          },
        };
        elements.push(element);
        return element;
      },
    },
    CM_decisions: {
      create: async (request: Record<string, unknown>) => {
        calls.push(JSON.parse(JSON.stringify(request)));
        return reply();
      },
    },
  });
  vm.runInContext(SCRIPT_DECISIONS_EXAMPLE, context);
  assert.ok(handler);
  await handler();
  assert.equal(elements[0].disabled, true);
  assert.equal(calls.length, 1, 'one click sends one request');
  return { output: elements[1].textContent, request: calls[0] };
}

const decision = (answers: unknown[]) => async () => ({
  model: 'gpt-6-luna',
  answers,
  usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
});

it('sends the written-out questions and keeps the answered probability without inventing a threshold', async () => {
  const result = await runExample(
    decision([{ type: 'predicate', name: 'needs_reply', probability: 0.72 }]),
  );
  assert.deepEqual(result.request, {
    input: 'Can you help me reset my password?',
    questions: SCRIPT_DECISIONS_QUESTIONS,
  });
  assert.deepEqual(JSON.parse(result.output), {
    state: 'completed',
    probability: 0.72,
  });
});

it('refusals are unanswered, not negative answers', async () => {
  const result = await runExample(
    decision([{ type: 'refusal', name: 'needs_reply' }]),
  );
  assert.deepEqual(JSON.parse(result.output), { state: 'unanswered' });
});

it('access and loop-guard errors stop the example with the sentence they carry, or their code without one', async () => {
  for (const code of ['key_unavailable', 'loop_paused', 'questions_not_in_code']) {
    const said = await runExample(async () => {
      throw Object.assign(new Error(`Script Decisions stopped for ${code}.`), { code });
    });
    assert.equal(said.output, `Stopped: Script Decisions stopped for ${code}.`);
    const bare = await runExample(async () => {
      throw Object.assign(new Error(''), { code });
    });
    assert.equal(bare.output, `Stopped: ${code}`);
  }
});

it('the guide teaches the agent tools, the grant behind them and what stays with the person', () => {
  const guide = SCRIPT_DECISIONS_CONVENTIONS;
  assert.match(guide, /^Needs extension 1\.5\.0 and MCP\/CLI 3\.4\.0, or later\./m);
  assert.match(guide, /^## Agents and Script Decisions$/m);
  assert.match(guide, /Only the person turns it on, through a protected confirmation in\s+the extension; no MCP tool or CLI command can/);
  assert.match(guide, /get_script_decisions, or customaise decisions \[id\]/);
  assert.match(guide, /set_script_decisions, or customaise decisions set <id>\s+<jev\|openai-decisions\|gemini-decisions\|off> \[--sets HASH,HASH\]/);
  assert.match(guide, /Switching a\s+script's provider Off is always allowed/);
  for (const kept of [/provider keys/, /the device's Allow Script\s+Decisions switch/, /daily limits/, /pausing this device/,
    /runaway loop \(loop_runaway\)/, /scripts shared with them/]) {
    assert.match(guide, kept);
  }
  assert.match(guide, /error type person_required \(CLI exit 6\)[\s\S]{0,80}tell\s+the person, and do not retry/);
  // The keep-on-edit rule, and its absence without the grant.
  assert.match(guide, /saves a script with export_script while Script Decisions is on\s+for agents, Customaise signs the\s+provider again for the new code/);
  assert.match(guide, /Without the grant, or when the provider was not current, the person chooses\s+it again/);
  assert.doesNotMatch(guide, /neither\s+can MCP\/CLI/);
  assert.doesNotMatch(guide, /—/);
});

it('no surface an agent reads still says MCP or the CLI cannot choose a provider', () => {
  for (const [name, text] of [['guide', SCRIPT_DECISIONS_CONVENTIONS], ['server instructions', SERVER_INSTRUCTIONS],
    ['CLI primer', buildPrimer('3.2.9')]] as const) {
    assert.doesNotMatch(text, /MCP(?:\/CLI)?\s+cannot grant its permissions|neither\s+can MCP\/CLI/, name);
    assert.match(text, /set_script_decisions|customaise decisions set/, `${name} does not name the way to choose a provider`);
    assert.doesNotMatch(text, /—/, name);
  }
  assert.match(SERVER_INSTRUCTIONS, /No tool can turn that on, and keys, device access, daily limits, the device pause, runaway-loop pauses and shared scripts stay with the person/);
});

// A fresh agent given only these documents (23 November 2026) found one
// complete example, a UserScript, and had to assemble the AgentScript case
// from two documents. The guide now ships one, and this runs it.
async function runAgentExample(createMany: (request: Record<string, unknown>, options: unknown) => Promise<unknown>) {
  const tools: Array<{ name: string; execute: (args: unknown) => Promise<Record<string, unknown>> }> = [];
  const context = vm.createContext({ document: { modelContext: { registerTool: (tool: never) => { tools.push(tool); } } }, CM_decisions: { createMany } });
  vm.runInContext(SCRIPT_DECISIONS_AGENT_EXAMPLE, context);
  assert.deepEqual(tools.map((tool) => tool.name), ['msg_triage']);
  return tools[0].execute;
}

it('the guide carries a whole AgentScript that judges a list in one call', async () => {
  assert.match(SCRIPT_DECISIONS_CONVENTIONS, /^## Working AgentScript$/m);
  assert.ok(SCRIPT_DECISIONS_CONVENTIONS.includes(SCRIPT_DECISIONS_AGENT_EXAMPLE));
  assert.match(SCRIPT_DECISIONS_AGENT_EXAMPLE, /^\/\/ @grant CM_decisions$/m);
  assert.match(SCRIPT_DECISIONS_AGENT_EXAMPLE, /^\/\/ @webmcp msg_triage prompt$/m);

  const sent: Array<{ request: Record<string, unknown>; options: unknown }> = [];
  const execute = await runAgentExample(async (request, options) => {
    sent.push({ request: JSON.parse(JSON.stringify(request)), options: JSON.parse(JSON.stringify(options)) });
    return [
      { answers: [{ type: 'predicate', name: 'needs_reply', probability: 0.91 }, { type: 'choice', name: 'topic', choice: 'login', confidence: 0.8 }] },
      { error: { code: 'pending' } },
      { answers: [{ type: 'refusal', name: 'needs_reply' }] },
      { error: { code: 'rate_limited' } },
    ];
  });
  const result = JSON.parse(JSON.stringify(await execute({ messages: ['a?', 'b', 'a?', 'c', 'd', '  ', 7] })));
  // Each text once, in one call, with a wait that ends inside an agent's 30 seconds.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].request.inputs, ['a?', 'b', 'c', 'd']);
  assert.deepEqual(sent[0].options, { waitMs: 20000 });
  assert.deepEqual(result.rows, [
    { text: 'a?', state: 'answered', probability: 0.91, topic: 'login' },
    { text: 'b', state: 'pending', code: 'pending' },
    // A refusal is not read as a "no", and a provider's failure is not an answer.
    { text: 'c', state: 'not_answered', code: 'refused' },
    { text: 'd', state: 'not_answered', code: 'rate_limited' },
  ]);
  assert.match(result.note, /Call again with the same messages/);
  assert.equal(result.stopped, undefined);
});

it('that AgentScript says why when the whole call stops, and what was answered before it did', async () => {
  const execute = await runAgentExample(async () => {
    throw Object.assign(new Error('No provider is chosen for this script yet. Choose one in its Decisions menu.'), {
      code: 'authorization_required', setup: ['Choose a provider.'], results: [null, null],
    });
  });
  const result = JSON.parse(JSON.stringify(await execute({ messages: ['a', 'b'] })));
  assert.deepEqual(result.stopped, { code: 'authorization_required', message: 'No provider is chosen for this script yet. Choose one in its Decisions menu.', setup: ['Choose a provider.'] });
  assert.deepEqual(result.rows.map((row: { state: string }) => row.state), ['not_sent', 'not_sent']);
  assert.deepEqual(JSON.parse(JSON.stringify(await execute({}))), { error: 'no_messages', message: 'Pass messages: a list of texts.' });
});

it('the guide says how an agent chooses a provider for a new script, and that the questions are paid for with every input', () => {
  const guide = SCRIPT_DECISIONS_CONVENTIONS;
  assert.match(guide, /one whose\s+key is saved \(keySaved\)/);
  assert.match(guide, /no reload is needed for it,\s+only for changed code/);
  assert.match(guide, /The questions are sent with every input, so their length is paid for once\s+per input/);
  assert.match(guide, /a question list is a set \(sets,\s+hashes\), and a decision is a row/);
});
