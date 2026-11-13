import { it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  SCRIPT_DECISIONS_CONVENTIONS,
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
  assert.match(guide, /^Release reference: extension 1\.4\.1 and MCP\/CLI 3\.3\.0\./m);
  assert.match(guide, /^## Agents and Script Decisions$/m);
  assert.match(guide, /Only the person turns it on, through a protected confirmation in\s+the extension; no MCP tool or CLI command can/);
  assert.match(guide, /get_script_decisions, or customaise decisions \[id\]/);
  assert.match(guide, /set_script_decisions, or customaise decisions set <id>\s+<jev\|openai-decisions\|off> \[--sets HASH,HASH\]/);
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
