/**
 * Delivery resolution and the inline budget.
 *
 * The behaviour worth pinning is the ORDER: an explicit argument beats the
 * environment, the environment beats the default, and the default is `file`.
 * A chat client that lands on the default gets a dead end (it cannot read
 * the file it is told about), so the default being wrong for it is a
 * deliberate trade — recovered by the retry instruction in the response, not
 * by guessing at the client. If someone later "fixes" the default to
 * `inline`, every IDE session starts paying full DOM snapshots into its
 * context window, which is the bug the spool exists to prevent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INLINE_IMAGE_MAX_KB,
  DEFAULT_INLINE_MAX_KB,
  asKB,
  fileModeHint,
  inlineBudgetBytes,
  inlineHint,
  inlineImageBudgetBytes,
  parseDataUrl,
  pruneToBudget,
  resolveDelivery,
} from '../context-delivery.js';

describe('resolveDelivery', () => {
  it('defaults to file with nothing set', () => {
    assert.deepEqual(resolveDelivery(undefined, {}), { mode: 'file', source: 'default' });
    assert.deepEqual(resolveDelivery('auto', {}), { mode: 'file', source: 'default' });
  });

  it('lets the environment move the default, which is what the .mcpb bundle does', () => {
    assert.deepEqual(
      resolveDelivery('auto', { CUSTOMAISE_MCP_OUTPUT: 'inline' }),
      { mode: 'inline', source: 'environment' },
    );
    assert.deepEqual(
      resolveDelivery(undefined, { CUSTOMAISE_MCP_OUTPUT: 'file' }),
      { mode: 'file', source: 'environment' },
    );
  });

  it('lets an explicit argument beat the environment in both directions', () => {
    // The recovery path: a chat client on a file-configured server asks for
    // inline and gets it.
    assert.deepEqual(
      resolveDelivery('inline', { CUSTOMAISE_MCP_OUTPUT: 'file' }),
      { mode: 'inline', source: 'argument' },
    );
    // And the reverse: an IDE agent on an inline-configured server that
    // wants the big snapshot spooled rather than pasted into its context.
    assert.deepEqual(
      resolveDelivery('file', { CUSTOMAISE_MCP_OUTPUT: 'inline' }),
      { mode: 'file', source: 'argument' },
    );
  });

  it('ignores an unparseable env value rather than failing the call', () => {
    for (const raw of ['', 'FILE ', 'yes', 'true', 'workspace']) {
      const d = resolveDelivery('auto', { CUSTOMAISE_MCP_OUTPUT: raw });
      assert.equal(d.mode, 'file', `"${raw}" should not select a mode`);
    }
  });

  it('accepts the env value case- and whitespace-insensitively', () => {
    assert.equal(resolveDelivery('auto', { CUSTOMAISE_MCP_OUTPUT: '  INLINE  ' }).mode, 'inline');
  });
});

describe('inlineBudgetBytes', () => {
  it('defaults, and takes a positive override', () => {
    assert.equal(inlineBudgetBytes({}), DEFAULT_INLINE_MAX_KB * 1024);
    assert.equal(inlineBudgetBytes({ CUSTOMAISE_MCP_INLINE_MAX_KB: '8' }), 8 * 1024);
  });

  it('falls back rather than producing a zero or negative budget', () => {
    // A zero budget would prune every array to nothing and return a husk,
    // which reads as "the page is empty" rather than as a misconfiguration.
    for (const raw of ['0', '-5', 'lots', '']) {
      assert.equal(inlineBudgetBytes({ CUSTOMAISE_MCP_INLINE_MAX_KB: raw }), DEFAULT_INLINE_MAX_KB * 1024);
    }
  });
});

describe('pruneToBudget', () => {
  it('returns the input untouched when it already fits', () => {
    const v = { a: [1, 2, 3] };
    const r = pruneToBudget(v, 1024);
    assert.equal(r.value, v);
    assert.equal(r.withinBudget, true);
    assert.deepEqual(r.omissions, []);
  });

  it('shortens the largest array until the payload fits', () => {
    const big = { meta: { url: 'https://example.com' }, elements: Array.from({ length: 4000 }, (_, i) => ({ i, tag: 'div', selector: `#el-${i}` })) };
    const r = pruneToBudget(big, 4 * 1024);
    assert.equal(r.withinBudget, true);
    assert.ok(r.bytes <= 4 * 1024, `pruned to ${r.bytes} bytes`);
    assert.equal(r.omissions.length, 1);
    assert.equal(r.omissions[0].path, 'elements');
    assert.equal(r.omissions[0].kept + r.omissions[0].omitted, 4000);
    assert.ok(r.omissions[0].kept > 0, 'a sample survives so the shape is still legible');
  });

  it('leaves the object shape intact, which is the point of pruning over truncating', () => {
    const big = { url: 'u', title: 't', nested: { deep: { logs: Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`) } } };
    const r = pruneToBudget(big, 2 * 1024);
    // Every key survives at every level; only list items were dropped.
    assert.equal(r.value.url, 'u');
    assert.equal(r.value.title, 't');
    assert.ok(Array.isArray(r.value.nested.deep.logs));
    assert.equal(r.omissions[0].path, 'nested.deep.logs');
  });

  it('produces JSON that still parses, unlike a truncated string', () => {
    const big = { rows: Array.from({ length: 3000 }, (_, i) => ({ i, blob: 'y'.repeat(50) })) };
    const r = pruneToBudget(big, 3 * 1024);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.value)));
  });

  it('never mutates the caller\'s object', () => {
    const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ i, blob: 'z'.repeat(40) })) };
    const before = big.rows.length;
    pruneToBudget(big, 1024);
    assert.equal(big.rows.length, before);
  });

  it('spreads the trimming across several arrays when one is not enough', () => {
    const big = {
      errors: Array.from({ length: 1500 }, (_, i) => `e${i} ${'a'.repeat(30)}`),
      warnings: Array.from({ length: 1500 }, (_, i) => `w${i} ${'b'.repeat(30)}`),
    };
    const r = pruneToBudget(big, 2 * 1024);
    assert.equal(r.withinBudget, true);
    assert.equal(r.omissions.length, 2);
    assert.deepEqual(new Set(r.omissions.map((o) => o.path)), new Set(['errors', 'warnings']));
  });

  it('never reports an omission at a path the output does not contain', () => {
    // The parent is always >= any child by serialized size, so the parent is
    // halved first. A giant child in the DROPPED half is then detached, yet
    // it was still the biggest array the pruner's stale node list knew: it
    // burned passes shrinking it to no effect and then reported
    // `rows[9].giant (kept 62)` while `rows` held 0 entries. An agent
    // reading that omission list reasons about data that is not there.
    const big = {
      rows: [
        ...Array.from({ length: 9 }, (_, i) => ({ i, logs: Array.from({ length: 100 }, (_, j) => `r${i}l${j}${'x'.repeat(40)}`) })),
        { i: 9, giant: Array.from({ length: 2000 }, (_, j) => `g${j}${'y'.repeat(40)}`) },
      ],
    };
    const r = pruneToBudget(big, 4 * 1024);
    const resolve = (root: unknown, path: string): unknown => {
      let cur: any = root;
      for (const p of path.split(/\.|\[|\]/).filter(Boolean)) {
        if (cur == null) return undefined;
        cur = cur[/^\d+$/.test(p) ? Number(p) : p];
      }
      return cur;
    };
    for (const o of r.omissions) {
      const v = resolve(r.value, o.path);
      assert.ok(Array.isArray(v), `${o.path} reported but not present in the output`);
      assert.equal((v as unknown[]).length, o.kept, `${o.path} claims kept ${o.kept}`);
    }
  });

  it('converges fast on many sibling arrays, which is the shape an adversary controls', () => {
    // Sibling arrays with no common array ancestor (a snapshot keyed by
    // section, logs grouped per source): every pass can only halve one of
    // them. The naive loop re-serialized the whole clone per pass — 27s of
    // synchronous CPU on THIS input, stalling the daemon for every
    // connected client. The byte-estimate rewrite books trims against the
    // measured size of the dropped slice and pays for one real
    // serialization per round: 180ms on the same input.
    //
    // The bound must sit BETWEEN the two implementations, with margin on
    // both sides. The first version of this test used a smaller input the
    // naive code finished in 1.3s against a 2s bound — a regression test
    // the regression passes. 5s here is 5x above the rewrite's worst
    // plausible CI time and 5x below the naive implementation's best.
    const grouped: Record<string, { logs: string[] }> = {};
    for (let i = 0; i < 2000; i++) {
      grouped[`s${i}`] = { logs: Array.from({ length: 40 }, (_, j) => `s${i}l${j}${'y'.repeat(40)}`) };
    }
    const started = Date.now();
    const r = pruneToBudget(grouped, 64 * 1024);
    const elapsed = Date.now() - started;
    assert.equal(r.withinBudget, true);
    assert.ok(r.bytes <= 64 * 1024, `landed at ${r.bytes} bytes`);
    assert.ok(elapsed < 5000, `took ${elapsed}ms; the naive per-pass serialization is back`);
  });

  it('gives up gracefully when there is no array left to shrink', () => {
    // A single enormous string cannot be pruned by this strategy. Reporting
    // withinBudget:false beats looping forever or emitting half a string.
    const r = pruneToBudget({ blob: 'q'.repeat(20_000) }, 1024);
    assert.equal(r.withinBudget, false);
    assert.deepEqual(r.omissions, []);
  });
});

describe('inlineImageBudgetBytes', () => {
  it('is much larger than the JSON budget, because an image cannot be shortened', () => {
    assert.equal(inlineImageBudgetBytes({}), DEFAULT_INLINE_IMAGE_MAX_KB * 1024);
    assert.ok(inlineImageBudgetBytes({}) > inlineBudgetBytes({}));
  });

  it('takes a positive override and ignores nonsense', () => {
    assert.equal(inlineImageBudgetBytes({ CUSTOMAISE_MCP_INLINE_IMAGE_MAX_KB: '4096' }), 4096 * 1024);
    for (const raw of ['0', '-1', 'big', '']) {
      assert.equal(inlineImageBudgetBytes({ CUSTOMAISE_MCP_INLINE_IMAGE_MAX_KB: raw }), DEFAULT_INLINE_IMAGE_MAX_KB * 1024);
    }
  });
});

describe('parseDataUrl', () => {
  it('reads the real mime type rather than assuming png', () => {
    // The handler used to strip a hardcoded `data:image/png;base64,` prefix.
    // On any other mime type that left the prefix in the payload and the
    // attachment decoded to garbage.
    assert.deepEqual(parseDataUrl('data:image/jpeg;base64,AAEC'), { mimeType: 'image/jpeg', base64: 'AAEC' });
    assert.deepEqual(parseDataUrl('data:image/png;base64,QUJD'), { mimeType: 'image/png', base64: 'QUJD' });
  });

  it('round-trips real bytes', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { base64, mimeType } = parseDataUrl(`data:image/png;base64,${bytes.toString('base64')}`);
    assert.equal(mimeType, 'image/png');
    assert.deepEqual(Buffer.from(base64, 'base64'), bytes);
  });

  it('degrades to png rather than throwing on a malformed url', () => {
    assert.equal(parseDataUrl('').mimeType, 'image/png');
    assert.equal(parseDataUrl(undefined as unknown as string).base64, '');
  });
});

describe('hints', () => {
  it('file mode names the exact argument an agent must retry with', () => {
    const h = fileModeHint('get_page_context', 'Full DOM snapshot', 'Use view_file.');
    assert.match(h, /output: "inline"/);
    assert.match(h, /get_page_context/);
  });

  it('inline mode admits truncation and names what was dropped', () => {
    const quiet = inlineHint('get_console_context', []);
    assert.doesNotMatch(quiet, /SHORTENED/);
    assert.match(quiet, /Full payload/);

    // Over budget with nothing trimmed: the payload had no lists to
    // shorten, so it is COMPLETE. For one revision this was flagged
    // truncated and the hint claimed a full payload while the flag said
    // parts were missing — the hint must own the over-budget case instead.
    const complete = inlineHint('get_console_context', [], false);
    assert.match(complete, /nothing was dropped/);
    assert.doesNotMatch(complete, /SHORTENED/);

    const loud = inlineHint('get_console_context', [{ path: 'errors', kept: 10, omitted: 90 }]);
    assert.match(loud, /SHORTENED/);
    assert.match(loud, /errors \(10 of 100\)/);
    assert.match(loud, /CUSTOMAISE_MCP_INLINE_MAX_KB/);
  });
});

describe('asKB', () => {
  it('matches the existing fileSizeKB formatting', () => {
    assert.equal(asKB(1024), '1.0 KB');
    assert.equal(asKB(1536), '1.5 KB');
    assert.equal(asKB(0), '0.0 KB');
  });
});
