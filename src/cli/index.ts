#!/usr/bin/env node
/**
 * `customaise` — the terminal control plane for the Customaise extension.
 *
 * Output contract, which is most of why this beats a widget an agent has to
 * screenshot:
 *
 *   • JSON on stdout, always. There is no `--json` flag, because a flag is
 *     something an agent can forget and then try to parse prose. `--pretty`
 *     indents that same JSON, on stdout, so a pipe into `jq` keeps working
 *     either way. It does NOT move output to stderr: this comment and the
 *     --help line both said it did, while the code has always written to
 *     stdout, so anyone who redirected stderr to read it saw nothing.
 *   • stderr carries diagnostics only, never the result.
 *   • Meaningful exit codes. See exit-codes.ts.
 *
 * Every path argument is resolved to an absolute path before dispatch. The
 * daemon is long-lived and was spawned from whatever directory the first
 * invocation happened to be in, so a relative path would land somewhere the
 * user cannot see.
 */

import { resolve as resolvePath } from 'node:path';
import { EXIT, exitCodeForErrorType } from './exit-codes.js';
import { isRejection, rejectionMessage } from './rejection.js';
import { buildPrimer, PRIMER_BEGIN, PRIMER_END } from './primer.js';
import { installCrashGuard, connectToDaemon } from './connect.js';
import { PKG_VERSION } from '../build-server.js';
import { readState, writeState, resolveTab } from './state.js';

let pretty = false;

function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0) + '\n');
}

function fail(code: number, message: string): never {
  process.stderr.write('customaise: ' + message + '\n');
  emit({ ok: false, error: { message } });
  process.exit(code);
}

const USAGE = `customaise ${PKG_VERSION}: drive the Customaise extension from a terminal

  customaise doctor                       bridge, sign-in, tier, quota, gate
      --script ID [--operation ID]         inspect a save after a timeout
  customaise tools [--tab N]              WebMCP tools registered on a tab
  customaise call <tool> [--args JSON]    invoke a WebMCP tool
  customaise scripts list                 installed scripts
  customaise scripts get <id> -o FILE     write a script to a local file
  customaise scripts install FILE [--id ID]  push a local file into Customaise
  customaise scripts enable|disable <id>  turn a script on or off
  customaise scripts fork <id> -o FILE    fork a shared script into an editable copy
  customaise scripts rm <id>              delete a script
  customaise sync <dir>                   bulk-export your scripts to a directory
  customaise tabs                         open browser tabs
  customaise tab open <url> | focus <id>   close and reload take an optional id
  customaise tab list | shot -o FILE | use --tab N
                                          noun-verb forms of tabs / shot / use
  customaise context <page|console|selection> [--tab N]
                                          selection -o DIR writes .dom.md there
  customaise shot [--tab N] -o FILE       screenshot a tab
  customaise use --tab N                  remember a tab for later commands
  customaise daemon <status|stop>         inspect or stop the resident daemon
  customaise init [-o FILE]               write an agent primer (default AGENTS.md)
  customaise resources                    documents the server publishes
  customaise resource <name|uri>          read one, e.g. agentscript-conventions
  customaise schema                       the command tree as JSON, for agents

Typical loop:
  customaise scripts install ./my-tool.agent.js
  customaise tab reload 42
  customaise call my_tool --args '{"q":"hi"}'

  --pretty     indent the JSON (still stdout, still pipeable)
  --version    print the version
  -h, --help   this text

JSON on stdout, diagnostics on stderr. Exit: 0 ok, 2 usage, 3 unavailable,
4 sign-in expired, 5 cap reached, 6 consent denied, 7 consent timed out,
8 rejected by Customaise (see diagnostics).`;

/**
 * The command tree as data, for `customaise schema`.
 *
 * An agent discovers a CLI by asking it, not by reading a README it may
 * never have been shown. `--help` is prose for a human; this is the same
 * surface as JSON on stdout, with the MCP tool each verb reaches so an agent
 * holding both doors can see they are one thing. Kept next to USAGE so the
 * two are edited together; a test fails if a verb exists in one and not the
 * other, or names a tool the server does not register.
 */
const COMMANDS: ReadonlyArray<{ command: string; description: string; tool?: string; flags?: string[] }> = [
  { command: 'doctor', description: 'bridge, sign-in, tier, quota, gate; costs no quota', tool: 'get_bridge_status', flags: ['--script ID', '--operation ID'] },
  { command: 'tools', description: 'WebMCP tools registered on a tab', tool: 'list_webmcp_tools', flags: ['--tab N'] },
  { command: 'call <tool>', description: 'invoke a WebMCP tool; may wait for the user to approve', tool: 'call_webmcp_tool', flags: ['--args JSON', '--tab N'] },
  { command: 'scripts list', description: 'installed scripts', tool: 'list_scripts' },
  { command: 'scripts get <id>', description: 'write a script to a local file', tool: 'import_script', flags: ['-o FILE'] },
  { command: 'scripts install FILE', description: 'push a local file into Customaise', tool: 'export_script', flags: ['--id ID'] },
  { command: 'scripts enable <id>', description: 'turn a script on', tool: 'toggle_script' },
  { command: 'scripts disable <id>', description: 'turn a script off', tool: 'toggle_script' },
  { command: 'scripts fork <id>', description: 'fork a shared script into an editable copy', tool: 'import_script', flags: ['-o FILE'] },
  { command: 'scripts rm <id>', description: 'delete a script', tool: 'delete_script' },
  { command: 'sync <dir>', description: 'bulk-export your scripts to a directory', tool: 'sync_scripts' },
  { command: 'tabs', description: 'open browser tabs', tool: 'list_tabs' },
  { command: 'tab list', description: 'open browser tabs (same as tabs)', tool: 'list_tabs' },
  { command: 'tab open <url>', description: 'open a tab', tool: 'open_tab' },
  { command: 'tab focus <id>', description: 'bring a tab to the front', tool: 'focus_tab' },
  { command: 'tab close [id]', description: 'close a tab (default: the remembered or active one)', tool: 'close_tab' },
  { command: 'tab reload [id]', description: 'reload a tab, re-injecting scripts', tool: 'reload_tab' },
  { command: 'tab shot', description: 'screenshot a tab (same as shot)', tool: 'take_screenshot', flags: ['-o FILE', '--tab N'] },
  { command: 'tab use', description: 'remember a tab for later commands (same as use)', flags: ['--tab N'] },
  { command: 'context page', description: 'DOM snapshot of a tab', tool: 'get_page_context', flags: ['--tab N'] },
  { command: 'context console', description: 'console output of a tab', tool: 'get_console_context', flags: ['--tab N'] },
  { command: 'context selection', description: 'elements the user selected visually', tool: 'get_selected_elements', flags: ['-o DIR'] },
  { command: 'shot', description: 'screenshot a tab', tool: 'take_screenshot', flags: ['-o FILE', '--tab N'] },
  { command: 'use', description: 'remember a tab for later commands; bare, print what is remembered', flags: ['--tab N'] },
  { command: 'daemon status', description: 'is the resident daemon running' },
  { command: 'daemon stop', description: 'stop the resident daemon' },
  { command: 'init', description: 'write an agent primer (default AGENTS.md)', flags: ['-o FILE'] },
  { command: 'resources', description: 'documents the server publishes, including how to build scripts' },
  { command: 'resource', description: 'read one resource by name or customaise:// uri' },
  { command: 'schema', description: 'this command tree as JSON' },
  { command: 'version', description: 'print the version' },
];

interface Flags { [k: string]: string | boolean }

/**
 * Flags that carry a value. Bare, they are a typo, and the typo used to be
 * silent: `--out` with nothing after it became boolean `true`, `abs(true)`
 * resolved to a path literally named "true", and the CLI wrote the file
 * there and exited 0 reporting success. Rejecting here rather than at each
 * call site keeps the next value-taking flag from reintroducing it.
 */
const VALUE_FLAGS = new Set(['tab', 'out', 'args', 'id', 'script', 'operation']);

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') { pretty = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; continue; }
      if (VALUE_FLAGS.has(key)) fail(EXIT.USAGE, '--' + key + ' expects a value.');
      flags[key] = true;
      continue;
    }
    if (a === '-h') { flags.help = true; continue; }
    if (a === '-o') {
      const next = argv[++i];
      if (next === undefined) fail(EXIT.USAGE, '-o expects a file path.');
      flags.out = next;
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

/** A positional tab id, rejected as a usage error rather than sent as NaN. */
function tabNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(EXIT.USAGE, 'tab id must be a number, got "' + raw + '"');
  if (!Number.isSafeInteger(n) || n < 0) fail(EXIT.USAGE, 'tab id must be a non-negative integer');
  return n;
}

function tabOf(flags: Flags): number | undefined {
  const raw = flags.tab;
  // `--tab` without a value is rejected in parseFlags, so `true` cannot
  // reach here; absent means "use the sticky tab, else the active one".
  if (raw === undefined) return resolveTab(undefined);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) fail(EXIT.USAGE, '--tab expects a non-negative integer, got "' + raw + '"');
  return resolveTab(n);
}

function parseArgs(flags: Flags): Record<string, unknown> {
  if (flags.args === undefined) return {};
  try { return JSON.parse(String(flags.args)); }
  catch (e: any) { return fail(EXIT.USAGE, '--args is not valid JSON: ' + e.message); }
}

/** Unwrap a tool result into the CLI's own envelope, honouring the error contract. */
/**
 * @param passthrough  The payload is a page's own tool result, not ours.
 *   `call_webmcp_tool` hands back whatever the page tool returned, so a page
 *   answering `{ success: false }` is reporting its own domain result. Do not
 *   reinterpret that as a CLI failure.
 */
function present(result: any, passthrough = false): never {
  const structured = result?.structuredContent;
  if (result?.isError) {
    const err = structured?.error ?? {};
    const message = err.message ?? result?.content?.[0]?.text ?? 'Tool call failed.';
    process.stderr.write('customaise: ' + message + '\n');
    emit({ ok: false, error: { ...err, message } });
    process.exit(exitCodeForErrorType(err.type));
  }
  const text = result?.content?.[0]?.text;
  let data: unknown = structured;
  // The server wraps a non-object result as `{ result }` so the shape does
  // not change with the negotiated protocol era. Unwrap it, so
  // `customaise tabs` yields a list rather than a list inside a box.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === 'result') data = (data as Record<string, unknown>).result;
  }
  if (data === undefined && typeof text === 'string') {
    // No structured half: the text is JSON unless a tool prepended the
    // master-gate banner, in which case handing back the raw string is
    // better than pretending it parsed.
    try { data = JSON.parse(text); } catch { data = text; }
  }
  // The "Allow user scripts" toggle is off, so nothing this agent installs will
  // run and no tool will ever register. Said on stderr, because stdout is the
  // machine-readable half and must stay parseable.
  if (data && typeof data === 'object' && (data as Record<string, unknown>).userScriptsDisabled === true) {
    process.stderr.write(
      'customaise: "Allow user scripts" is OFF for Customaise in chrome://extensions, '
      + 'so no script will run and no WebMCP tool will register. It resets every time '
      + 'Chrome restarts or the extension reloads.\n');
  }

  if (!passthrough && isRejection(data)) {
    const message = rejectionMessage(data);
    process.stderr.write('customaise: ' + message + '\n');
    emit({ ok: false, error: { type: 'rejected', message }, data });
    process.exit(EXIT.REJECTED);
  }

  emit({ ok: true, data });
  process.exit(EXIT.OK);
}

/** `use` is local state; it needs no daemon and no extension. */
function handleUse(flags: Flags): never {
  const raw = flags.tab;
  if (raw === undefined || raw === true) {
    emit({ ok: true, data: readState() });
    process.exit(EXIT.OK);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) fail(EXIT.USAGE, '--tab expects a non-negative integer, got "' + raw + '"');
  writeState({ ...readState(), tabId: n });
  emit({ ok: true, data: { tabId: n } });
  process.exit(EXIT.OK);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseFlags(argv);

  if (flags.version || positional[0] === 'version') { process.stdout.write(PKG_VERSION + '\n'); process.exit(EXIT.OK); }
  if (flags.help || positional.length === 0) { process.stderr.write(USAGE + '\n'); process.exit(positional.length ? EXIT.OK : EXIT.USAGE); }

  installCrashGuard(fail);

  const [verb, sub, third] = positional;

  if (verb === 'init') {
    // Deliberately before the daemon connect below: teaching an agent how to
    // use this should not require a browser, a sign-in, or a running daemon.
    // A developer wiring up a repo can run it on a plane.
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
    const target = resolvePath(String(flags.out ?? 'AGENTS.md'));
    const block = buildPrimer(PKG_VERSION);

    let next: string;
    let action: 'created' | 'updated' | 'appended';
    if (!existsSync(target)) {
      next = block + '\n';
      action = 'created';
    } else {
      const current = readFileSync(target, 'utf-8');
      const start = current.indexOf(PRIMER_BEGIN);
      const end = current.indexOf(PRIMER_END);
      if (start !== -1 && end !== -1 && end > start) {
        // Replace in place. Re-running must update the block, never stack a
        // second copy, or a project that runs this on every install ends up
        // with an AGENTS.md that is mostly us.
        next = current.slice(0, start) + block + current.slice(end + PRIMER_END.length);
        action = 'updated';
      } else {
        // Someone else's file. Append rather than rewrite: everything above
        // is theirs and none of it is ours to reformat.
        next = current.replace(/\s*$/, '') + '\n\n' + block + '\n';
        action = 'appended';
      }
    }

    try {
      writeFileSync(target, next, 'utf-8');
    } catch (e: any) {
      fail(EXIT.USAGE, 'Could not write ' + target + ': ' + (e?.message ?? e));
    }
    emit({ ok: true, data: { action, file: target } });
    process.exit(EXIT.OK);
  }

  if (verb === 'use') handleUse(flags);
  if (verb === 'doctor') {
    for (const name of ['script', 'operation']) {
      if (flags[name] !== undefined && (typeof flags[name] !== 'string' || !flags[name])) fail(EXIT.USAGE, `--${name} requires an ID`);
    }
    if (flags.operation && !flags.script) fail(EXIT.USAGE, '--operation requires --script');
  }

  // Local, like `init`: the tree does not change with the browser's state.
  if (verb === 'schema') {
    emit({
      ok: true,
      data: {
        version: PKG_VERSION,
        output: 'JSON on stdout, diagnostics on stderr; --pretty indents',
        commands: COMMANDS,
        exitCodes: {
          [EXIT.OK]: 'ok',
          [EXIT.ERROR]: 'error',
          [EXIT.USAGE]: 'usage: unknown verb, missing argument, bad JSON',
          [EXIT.UNAVAILABLE]: 'daemon or extension not reachable; do not retry blindly',
          [EXIT.AUTH]: 'signed out; retrying will not help',
          [EXIT.CAP]: 'free-tier cap reached; stop and surface the upgrade path',
          [EXIT.DENIED]: 'the user denied consent; do not retry',
          [EXIT.TIMEOUT]: 'consent expired unanswered; may retry once, with the user told why',
          [EXIT.REJECTED]: 'Customaise refused the input; the diagnostics say what to change',
        },
      },
    });
    process.exit(EXIT.OK);
  }

  // `daemon status` answers without starting anything.
  //
  // It has to verify rather than report the file back. The token file is
  // written by a live daemon and removed on a clean exit, but a hard kill
  // leaves it behind, and that is exactly the moment someone runs `status`.
  // An earlier version read the record and said `running: true`, which meant
  // the one command whose job is to tell you what is happening lied in the
  // only case you would ask.
  if (verb === 'daemon' && sub === 'status') {
    const { readDaemonRecord, tokenPath } = await import('../daemon.js');
    const rec = readDaemonRecord();
    if (!rec) {
      emit({ ok: true, data: { running: false } });
      process.exit(EXIT.OK);
    }
    let processAlive = false;
    try { process.kill(rec.pid, 0); processAlive = true; } catch { /* gone, or not ours */ }
    // Bounded: `status` must always answer. A wedged process holding the
    // port would otherwise hang the one command whose job is to tell you
    // what is going on.
    const { endpointAnswers } = await import('./connect.js');
    const serving = await endpointAnswers(rec.port);
    const running = processAlive && serving;
    emit({ ok: true, data: {
      running,
      ...(running ? {} : { staleRecord: tokenPath(), processAlive, serving }),
      port: rec.port, pid: rec.pid, version: rec.version,
    } });
    process.exit(EXIT.OK);
  }

  // `daemon stop` must not go through connectToDaemon: connecting spawns a
  // daemon when none is running, so `stop` on an idle machine would start
  // one purely to kill it and then report `stopped: true` for something that
  // had never been running.
  if (verb === 'daemon' && sub === 'stop') {
    const { readDaemonRecord } = await import('../daemon.js');
    const rec = readDaemonRecord();
    if (!rec) {
      emit({ ok: true, data: { stopped: false, reason: 'no daemon was running' } });
      process.exit(EXIT.OK);
    }
    let signalled = false;
    try { process.kill(rec.pid, 'SIGTERM'); signalled = true; } catch { /* already gone */ }
    emit({ ok: true, data: signalled
      ? { stopped: true, pid: rec.pid }
      : { stopped: false, reason: 'daemon was already gone', staleRecord: true, pid: rec.pid } });
    process.exit(EXIT.OK);
  }

  const { client, record } = await connectToDaemon(fail);

  const callTool = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }, name === 'export_script' ? {
      // The save has a 90-second absolute deadline; leave room for its final
      // status to arrive instead of abandoning it at the SDK's 60s default.
      timeout: 95_000,
      onprogress: progress => { if (progress.message) process.stderr.write('customaise: ' + progress.message + '\n'); },
    } : undefined);

  /**
   * `customaise call`, which is the one command that can legitimately block
   * for minutes rather than seconds.
   *
   * A call against a `prompt`-gated tool waits for the user to answer the
   * consent modal in the browser, up to five minutes; the extension holds
   * the dispatch open for exactly that long. The SDK's default request
   * timeout is 60 seconds, so without an explicit budget the CLI abandons
   * the call at minute one while the modal is still up — the user clicks
   * Approve at minute two and nobody is listening. Finding 46 in the ARD,
   * specified there and missed in the first implementation pass.
   *
   * The stderr note exists because a terminal that has said nothing for ten
   * seconds looks hung. It goes to stderr so stdout stays parseable JSON,
   * and it is cleared on completion so a fast call never prints it.
   */
  const CONSENT_BUDGET_MS = 330_000;
  const callToolWithConsentBudget = async (name: string, args: Record<string, unknown>) => {
    const note = setTimeout(() => {
      process.stderr.write(
        'customaise: still waiting. If this tool needs consent, an approval card is open on the page in the browser; with Remote Approvals on, it can also be answered from the account page or a phone (up to 5 minutes).\n',
      );
    }, 10_000);
    try {
      return await client.callTool({ name, arguments: args }, { timeout: CONSENT_BUDGET_MS });
    } finally {
      clearTimeout(note);
    }
  };

  /**
   * The JSON carries `__consent` for a call a person decided; this is the
   * same fact for a reader of the terminal, on stderr so stdout stays the
   * result. "Always allow" changes every later call of this tool, which is
   * worth a sentence at the moment it happens. Returns its input so the
   * call site stays one expression (the rejection test reads that line).
   */
  const noteConsent = <T,>(r: T): T => {
    const sc = (r as any)?.structuredContent;
    const consent = sc?.__consent ?? sc?.result?.__consent;
    if (consent && consent.gated) {
      const where = consent.decidedBy === 'remote' ? 'from another device'
        : consent.decidedBy === 'local' ? 'on the page in the browser'
        : 'by ' + String(consent.decidedBy ?? 'an unknown surface');
      const persisted = consent.persisted === 'allow'
        ? ' "Always allow" was chosen: this tool will not prompt again on this browser.'
        : '';
      process.stderr.write('customaise: a person approved this call ' + where + '.' + persisted + '\n');
    }
    return r;
  };

  const abs = (p: unknown) => resolvePath(String(p));

  switch (verb) {
    case 'doctor': {
      // `get_bridge_status` reads state the server already holds and spends
      // NO cap unit. This used to call `list_tabs`, so working out why MCP
      // was failing cost one of the fifty daily calls that might be why it
      // was failing.
      const r: any = await callTool('get_bridge_status', {
        ...(flags.script ? { scriptId: String(flags.script) } : {}),
        ...(flags.operation ? { operationId: String(flags.operation) } : {}),
      });
      const s = r?.structuredContent ?? {};
      const gateOff = s.systemStatus?.userScriptsDisabled === true;
      const reachable = !r?.isError && s.extensionConnected === true && !gateOff;

      // `null` means the extension never told us, which is not the same as
      // `false`. Say so rather than inventing a confident answer.
      const known = (v: unknown) => (v === null || v === undefined ? 'unknown' : v);
      const cap = s.capMode === 'unlimited'
        ? 'unlimited'
        : (s.dailyUsed === null || s.dailyUsed === undefined
            ? 'unknown'
            : `${s.dailyUsed}/${s.dailyCap} today, ${s.weeklyUsed}/${s.weeklyCap} this week`);

      emit({ ok: reachable, data: {
        cli: PKG_VERSION,
        daemon: record.version,
        // Which build actually holds :4050. The daemon may be a FOLLOWER of
        // an IDE-spawned leader from a different install, and this seam has
        // no version negotiation — so when something is inexplicably wrong
        // on a mixed fleet, this line is the diagnosis.
        leader: known(s.leaderVersion),
        node: process.versions.node,
        // Two ports, and an agent that sees only one of them reads the other
        // as a misconfiguration: the first Grok Bot run compared this line to
        // the extension's "waiting for localhost:4050" and went looking for a
        // fault that did not exist. `endpoint` is where THIS CLI talks to the
        // daemon; `extensionSocket` is where the extension dials the daemon.
        // They are meant to differ.
        endpoint: '127.0.0.1:' + record.port,
        // From the DAEMON's record, not this process's environment: the two can
        // differ (a daemon started with a different CUSTOMAISE_WS_PORT), and a
        // diagnostic that reports the caller's guess agrees with whoever is
        // asking rather than with the process being asked about. Falls back to
        // this environment only for a record an older daemon wrote.
        extensionSocket: 'ws://127.0.0.1:' + (record.wsPort ?? (Number(process.env.CUSTOMAISE_WS_PORT) || 4050)),
        extension: reachable
          ? 'connected'
          : (r?.structuredContent?.error?.type ?? (s.extensionConnected === false ? 'extension_not_connected' : 'unreachable')),
        signedIn: known(s.authenticated),
        tier: known(s.tier),
        cap,
        remoteApprovals: known(s.remoteApprovals),
        ...(s.saveStatus ? { saveStatus: s.saveStatus } : {}),
        ...(r?.isError ? { error: s.error ?? r.content } : {}),
        // The one switch that makes every script inert, and the reason this
        // was worth adding: diagnosing "my tools never appear" without it
        // means checking everything else first.
        userScripts: s.systemStatus
          ? (s.systemStatus.userScriptsDisabled ? 'DISABLED' : 'enabled')
          : 'unknown',
      } });
      process.exit(reachable ? EXIT.OK : EXIT.UNAVAILABLE);
      break;
    }
    case 'tools':   return present(await callTool('list_webmcp_tools', { tabId: tabOf(flags) }));
    case 'call': {
      if (!sub) fail(EXIT.USAGE, 'customaise call <tool> [--args JSON] [--tab N]');
      return present(noteConsent(await callToolWithConsentBudget('call_webmcp_tool', { toolName: sub, toolArgs: parseArgs(flags), tabId: tabOf(flags) })), true);
    }
    /*
     * Resources, not tools. The server publishes four, and two of them are the
     * only documents that say how to build a UserScript or an AgentScript.
     * Without a verb to reach them an agent with a shell can install scripts
     * and never learn how to write one, which bites hardest exactly where the
     * CLI is the only way in: a cloud agent VM cannot attach a local MCP
     * server at all.
     *
     * Missed because the ARD reasoned parity at the transport ("the CLI is a
     * client of the protocol, not of the transport, which is what keeps a
     * single definition of every tool") and then enumerated the command
     * surface from the TOOL list. The daemon was serving these the whole time.
     */
    case 'resources': return emit({ ok: true, resources: (await client.listResources()).resources });
    case 'resource': {
      if (!sub) fail(EXIT.USAGE, 'customaise resource <name|uri>   e.g. agentscript-conventions');
      // Bare names are accepted because that is what an agent reading the
      // list will type; the uri form still works verbatim.
      const uri = sub.includes('://') ? sub : `customaise://${sub}`;
      let read;
      try {
        read = await client.readResource({ uri });
      } catch (err: any) {
        fail(EXIT.USAGE,
          `No resource ${uri}. Run \`customaise resources\` to list them.`);
      }
      return emit({ ok: true, uri, contents: read.contents });
    }
    case 'tabs':    return present(await callTool('list_tabs', {}));
    case 'tab': {
      // Written out rather than dispatched through a name map, for two
      // reasons. The tool names stay literal, so the schema-conformance test
      // can see them. And each verb states its own contract: `focus` needs a
      // tab id and `close` does not, which a shared `args` expression cannot
      // express without getting one of them wrong.
      if (sub === 'list') return present(await callTool('list_tabs', {}));
      if (sub === 'use') handleUse(flags);
      if (sub === 'shot') {
        if (!flags.out) fail(EXIT.USAGE, 'customaise tab shot -o FILE [--tab N]');
        return present(await callTool('take_screenshot', { tabId: tabOf(flags), filePath: abs(flags.out), output: 'file' }));
      }
      if (sub === 'open') {
        if (!third) fail(EXIT.USAGE, 'customaise tab open <url>');
        return present(await callTool('open_tab', { url: third }));
      }
      if (sub === 'focus') {
        if (!third) fail(EXIT.USAGE, 'customaise tab focus <tabId>');
        return present(await callTool('focus_tab', { tabId: tabNumber(third) }));
      }
      if (sub === 'close') {
        return present(await callTool('close_tab',
          third === undefined ? {} : { tabId: tabNumber(third) }));
      }
      if (sub === 'reload') {
        return present(await callTool('reload_tab',
          third === undefined ? {} : { tabId: tabNumber(third) }));
      }
      return fail(EXIT.USAGE, 'customaise tab <list|open|close|focus|reload|shot|use> ...');
    }
    case 'scripts': {
      if (sub === 'list') return present(await callTool('list_scripts', {}));
      if (sub === 'get') {
        if (!third || !flags.out) fail(EXIT.USAGE, 'customaise scripts get <id> -o FILE');
        return present(await callTool('import_script', { scriptId: third, filePath: abs(flags.out) }));
      }
      if (sub === 'install') {
        if (!third) fail(EXIT.USAGE, 'customaise scripts install FILE [--id ID]');
        const { accessSync, constants } = await import('node:fs');
        const path = abs(third);
        try {
          // Probe rather than read: `export_script` takes a path and reads it
          // in the daemon, so reading here would only be to throw the content
          // away. The probe still earns the good error, because a path the
          // user mistyped is a usage error and an agent should not have to
          // parse an errno to work that out.
          accessSync(path, constants.R_OK);
        } catch (e: any) {
          fail(EXIT.USAGE, e?.code === 'ENOENT'
            ? 'No such file: ' + path
            : 'Could not read ' + path + ': ' + (e?.message ?? e));
        }
        return present(await callTool('export_script', { filePath: path, ...(flags.id ? { scriptId: String(flags.id) } : {}) }));
      }
      if (sub === 'rm') {
        if (!third) fail(EXIT.USAGE, 'customaise scripts rm <id>');
        return present(await callTool('delete_script', { scriptId: third }));
      }
      if (sub === 'enable' || sub === 'disable') {
        if (!third) fail(EXIT.USAGE, 'customaise scripts ' + sub + ' <id>');
        return present(await callTool('toggle_script', { scriptId: third, enabled: sub === 'enable' }));
      }
      if (sub === 'fork') {
        // Forking a subscribed script produces a new, editable, DISABLED
        // copy; the file it writes is that copy, not the original.
        if (!third || !flags.out) fail(EXIT.USAGE, 'customaise scripts fork <id> -o FILE');
        return present(await callTool('import_script', { scriptId: third, filePath: abs(flags.out), fork: true }));
      }
      return fail(EXIT.USAGE, 'customaise scripts <list|get|install|enable|disable|fork|rm> ...');
    }
    case 'sync': {
      if (!sub) fail(EXIT.USAGE, 'customaise sync <dir>');
      return present(await callTool('sync_scripts', { directory: abs(sub) }));
    }
    case 'context': {
      // Forward this shell's CUSTOMAISE_MCP_OUTPUT as an explicit argument.
      //
      // The tool's own `auto` resolution reads the env of the process it
      // runs in, and on this door that is the DAEMON — a long-lived
      // process that inherited its environment from whichever invocation
      // happened to spawn it, minutes or hours ago. So
      // `CUSTOMAISE_MCP_OUTPUT=inline customaise context page` did nothing
      // against a warm daemon, and worked against a cold one, which is a
      // coin-flip dressed as a setting. Measured both ways before this.
      // Reading it here makes the documented per-install setting behave
      // the same on both doors.
      const envOutput = ((): 'file' | 'inline' | undefined => {
        const v = String(process.env.CUSTOMAISE_MCP_OUTPUT ?? '').trim().toLowerCase();
        return v === 'file' || v === 'inline' ? v : undefined;
      })();
      const output = envOutput ? { output: envOutput } : {};
      if (sub === 'page') return present(await callTool('get_page_context', { tabId: tabOf(flags), ...output }));
      if (sub === 'console') return present(await callTool('get_console_context', { tabId: tabOf(flags), ...output }));
      if (sub === 'selection') {
        // `-o DIR` writes the .dom.md files and screenshots into DIR. This is
        // the unambiguous counterpart to the daemon's unsolicited push: a
        // push has to guess which workspace it belongs to and declines when
        // several are live, whereas this call knows, because you ran it
        // where you wanted the files.
        const dir = flags.out ? abs(flags.out) : undefined;
        return present(await callTool('get_selected_elements',
          dir ? { writeFiles: true, directory: dir } : {}));
      }
      return fail(EXIT.USAGE, 'customaise context <page|console|selection> [--tab N]');
    }
    case 'shot': {
      if (!flags.out) fail(EXIT.USAGE, 'customaise shot -o FILE [--tab N]');
      // `output: 'file'` is pinned, not defaulted. The tool's default reads
      // CUSTOMAISE_MCP_OUTPUT from the DAEMON's environment, and under
      // `inline` the handler ignores filePath entirely — so a user who set
      // that for a chat client would ask for -o FILE and silently get no
      // file. This command's whole contract is the path it was given.
      return present(await callTool('take_screenshot', { tabId: tabOf(flags), filePath: abs(flags.out), output: 'file' }));
    }
    default:
      return fail(EXIT.USAGE, 'unknown command "' + verb + '". Try --help.');
  }
}

main().catch((err: any) => fail(EXIT.ERROR, err?.message ?? String(err)));
