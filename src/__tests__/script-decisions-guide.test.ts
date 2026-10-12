import { it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  SCRIPT_DECISIONS_EXAMPLE,
  SCRIPT_DECISIONS_TASK,
} from '../script-decisions-guide.js';

it('the shipped example declares the documented task and grant', () => {
  const declaration = SCRIPT_DECISIONS_EXAMPLE.match(
    /^\/\/ @decisions (.+)$/m,
  )![1];
  assert.deepEqual(JSON.parse(declaration).tasks, [SCRIPT_DECISIONS_TASK]);
  assert.match(SCRIPT_DECISIONS_EXAMPLE, /@grant CM_decisions/);
});

async function runExample(
  status: Record<string, unknown> | ((poll: number) => Record<string, unknown>),
  error?: Error,
) {
  let runs = 0,
    polls = 0;
  let handler: (() => Promise<void>) | undefined;
  const elements: Array<{
    textContent: string;
    disabled?: boolean;
    addEventListener: (event: string, fn: () => Promise<void>) => void;
  }> = [];
  const context = vm.createContext({
    setTimeout: (fn: () => void) => {
      fn();
    },
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
      run: async () => {
        runs++;
        if (error) throw error;
        return { proposalId: 'operation-1', state: 'running', records: [] };
      },
      status: async (id: string) => {
        assert.equal(id, 'operation-1');
        polls++;
        return {
          proposalId: id,
          records: [],
          ...(typeof status === 'function' ? status(polls) : status),
        };
      },
    },
  });
  vm.runInContext(SCRIPT_DECISIONS_EXAMPLE, context);
  assert.ok(handler);
  await handler();
  assert.equal(elements[0].disabled, true);
  assert.equal(runs, 1, 'polling must never issue another paid run');
  return { output: elements[1].textContent, polls };
}

it('the example preserves an answered predicate without inventing a threshold', async () => {
  const result = await runExample({
    state: 'completed',
    records: [
      {
        id: 'message-1',
        answers: [
          {
            id: 'reply',
            type: 'predicate',
            status: 'answered',
            probability: 0.72,
          },
        ],
      },
    ],
  });
  assert.deepEqual(JSON.parse(result.output), {
    state: 'completed',
    probability: 0.72,
  });
});

it('refusals are unanswered, not negative answers', async () => {
  const result = await runExample({
    state: 'completed',
    records: [
      {
        id: 'message-1',
        answers: [{ id: 'reply', type: 'predicate', status: 'refused' }],
      },
    ],
  });
  assert.deepEqual(JSON.parse(result.output), { state: 'unanswered' });
});

it('a bounded wait retains the operation ID without resubmission', async () => {
  const result = await runExample({ state: 'running' });
  assert.equal(result.polls, 30);
  assert.deepEqual(JSON.parse(result.output), {
    state: 'pending',
    proposalId: 'operation-1',
  });
});

it('access and uncertain-provider errors stop the example', async () => {
  assert.match(
    (
      await runExample({
        state: 'authorization_paused',
        code: 'dispatch_uncertain',
      })
    ).output,
    /Stopped: dispatch_uncertain/,
  );
  const result = await runExample({}, new Error('device_paused'));
  assert.equal(result.polls, 0);
  assert.match(result.output, /Stopped: device_paused/);
});

it('replay rejection after navigation stops without requesting a fresh paid operation', async () => {
  const result = await runExample({}, new Error('operation_already_used'));
  assert.equal(result.polls, 0);
  assert.match(result.output, /Stopped: operation_already_used/);
});

it('consumes completion on the last allowed poll', async () => {
  const result = await runExample((poll) =>
    poll < 30
      ? { state: 'running' }
      : {
          state: 'completed',
          records: [
            {
              id: 'message-1',
              answers: [
                {
                  id: 'reply',
                  type: 'predicate',
                  status: 'answered',
                  probability: 0.9,
                },
              ],
            },
          ],
        },
  );
  assert.equal(result.polls, 30);
  assert.equal(JSON.parse(result.output).state, 'completed');
});
