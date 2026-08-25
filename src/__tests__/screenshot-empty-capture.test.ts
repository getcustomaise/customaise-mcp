/**
 * A capture with no pixels must FAIL, not "succeed" as a 0-byte PNG.
 *
 * The pre-delivery-refactor handler threw here by accident:
 * `result.dataUrl.replace(...)` on an undefined dataUrl was a TypeError,
 * which the tool envelope shaped into a proper isError with an exit code.
 * The lenient `parseDataUrl` removed the accident, and for one revision the
 * handler wrote an empty file and returned `success: true` on a bridge
 * fault. This pins the deliberate guard that replaced the accidental one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../server.js';

type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

function screenshotHandler(bridgeResult: Record<string, unknown>): Handler {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  };
  const bridge = {
    dispatchTool: async () => ({ ...bridgeResult }),
    getSystemStatus: () => null,
    onPush: () => {},
    isConnected: true,
  };
  registerTools(server as never, bridge as never);
  return tools.get('take_screenshot')!;
}

describe('take_screenshot with no image data', () => {
  for (const [label, result] of [
    ['an absent dataUrl', { width: 100, height: 100 }],
    ['an empty dataUrl', { dataUrl: '', width: 100, height: 100 }],
  ] as const) {
    it(`throws on ${label} instead of writing a 0-byte file`, async () => {
      await assert.rejects(
        () => screenshotHandler(result)({}, {}),
        /no image data/,
      );
    });
  }

  it('still succeeds on a real capture, in both delivery modes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const good = { dataUrl: `data:image/png;base64,${png}`, width: 1, height: 1 };

    const inline = (await screenshotHandler(good)({ output: 'inline' }, {})) as {
      content: Array<{ type: string; data?: string }>;
    };
    const image = inline.content.find((c) => c.type === 'image');
    assert.ok(image, 'inline mode returns an image block');
    assert.equal(image!.data, png);

    const file = (await screenshotHandler(good)({}, {})) as {
      structuredContent: { delivery: string; filePath?: string };
    };
    assert.equal(file.structuredContent.delivery, 'file');
    assert.ok(file.structuredContent.filePath, 'file mode returns a path');
  });
});
