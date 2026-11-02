/**
 * Everything the CLI prints goes through here, and is written in full before
 * the call returns.
 *
 * Every command ends in `process.exit`, and on macOS a write to a pipe through
 * `process.stdout` is asynchronous: whatever the pipe's 64 KiB buffer could not
 * take at once was still queued when the process exited, and was dropped. A
 * result piped into `jq`, or into an agent's reader, stopped at exactly 65,536
 * bytes and no longer parsed, while the same call redirected to a file came out
 * whole. A write that waits until the reader has taken every byte cannot be cut
 * short, and keeps stdout and stderr in order when the two share one pipe
 * (`2>&1`). `cli-output-whole.test.ts` fails on any other way of printing.
 */

import { writeSync } from 'node:fs';

const pause = new Int32Array(new SharedArrayBuffer(4));

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (err: any) {
      // The pipe is full and was left non-blocking: Node does that to a stream
      // it has opened, and under 2>&1 stdout and stderr are one pipe. Give the
      // reader a moment.
      if (err?.code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 5); continue; }
      // The reader has gone (`| head`), so nobody is left to read the rest.
      if (err?.code === 'EPIPE') return;
      throw err;
    }
  }
}

/** The result: JSON on stdout. */
export function writeOut(text: string): void {
  writeAll(1, text);
}

/** Diagnostics, on stderr. */
export function writeErr(text: string): void {
  writeAll(2, text);
}
