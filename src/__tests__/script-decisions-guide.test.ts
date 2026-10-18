import { it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  SCRIPT_DECISIONS_CONVENTIONS,
  SCRIPT_DECISIONS_EXAMPLE,
  SCRIPT_DECISIONS_QUESTIONS,
} from '../script-decisions-guide.js';

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

it('access and loop-guard errors stop the example with their code', async () => {
  for (const code of ['key_unavailable', 'loop_paused', 'questions_not_in_code']) {
    const result = await runExample(async () => {
      throw Object.assign(new Error(`CM_decisions: ${code}`), { code });
    });
    assert.equal(result.output, `Stopped: ${code}`);
  }
});
