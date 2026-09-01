/**
 * The one description of how to drive Customaise from a terminal.
 *
 * `customaise init` writes this into a project so an agent reads it without a
 * human relaying anything, which is the whole discovery problem: an agent with
 * only a shell has no way to learn this tool exists. Everything else points
 * here rather than restating it, because four copies of a usage guide is the
 * same defect as the three divergent IDE lists already in the defect log.
 */

/** Fences the managed block so a re-run replaces it instead of duplicating it. */
export const PRIMER_BEGIN = '<!-- customaise:begin -->';
export const PRIMER_END = '<!-- customaise:end -->';

export function buildPrimer(version: string): string {
  return `${PRIMER_BEGIN}
## Customaise CLI

Drive a real Chrome session from this terminal: install userscripts and
AgentScripts, inspect pages, and call the WebMCP tools your AgentScripts
register.

Four things must be true, and the last one catches everyone: the extension
installed, you signed in, the Agent Bridge on in its Settings, and **"Allow user
scripts" ticked on the Customaise card in \`chrome://extensions\`**. That last
toggle resets every time Chrome restarts or the extension reloads, and while
it is off nothing runs: scripts install successfully, no tool ever registers,
and the only thing that tells you is the check below.

Check it works before anything else. This costs no quota:

\`\`\`sh
customaise doctor
\`\`\`

It reports the daemon, whether the extension is attached, whether you are
signed in, your plan tier, how much quota is left, whether remote approvals are
on, and whether user scripts are allowed. If it exits 3, stop and read the
message rather than retrying: every cause of a 3 needs a person, not a retry.

Two ports appear in its output and they are meant to differ. \`endpoint\`
(127.0.0.1:4051 by default) is where this CLI talks to the daemon.
\`extensionSocket\` (ws://127.0.0.1:4050) is where the browser extension dials
the daemon; the extension's settings panel shows that one. Seeing 4051 here
and 4050 there is not a mismatch. If \`extension\` is not \`connected\`, the fix
is in the browser (sign in, then turn on the Agent Bridge in Customaise settings),
not in the port.

### Before you write a script

Customaise has two kinds and they are built differently. Read the one you need
before writing anything; this is the same text an MCP client gets.

\`\`\`sh
customaise resources                              # what is published
customaise resource userscript-conventions        # DOM manipulation
customaise resource agentscript-conventions       # tools for AI agents
\`\`\`

### The loop

\`\`\`sh
customaise scripts install ./my-tool.agent.js   # validate + install
customaise tab reload 42                        # re-inject on the page
customaise call my_tool --args '{"q":"hello"}'  # invoke it
\`\`\`

A \`call\` can block for up to five minutes while a person approves it, on the
page in the browser or from another device. When it returns, a call a person
decided carries \`__consent\` (\`decidedBy\`: \`local\` or \`remote\`;
\`persisted\`: \`allow\` when they chose "Always allow", after which the tool
stops prompting). A result without \`__consent\` never waited on anyone. Do
not ask the person whether they clicked; read the field.

\`call\` already waits for the tool to register, so there is no need to check
first. Do not poll \`customaise tools\` in a loop to see whether it appeared:
every call spends a quota unit, and the wait is free inside \`call\`.

### Output contract

JSON on stdout, diagnostics on stderr, so \`| jq\` works. Branch on the exit
code, never on message text:

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | your command was malformed; fix and retry |
| 3 | daemon or extension unreachable; stop, do not retry blindly |
| 4 | sign-in expired; the user must act |
| 5 | quota reached; stop and surface the upgrade path |
| 6 | the user denied consent; a decision, do not retry |
| 7 | consent expired unanswered; may retry once |
| 8 | Customaise rejected the input; read \`error\` and fix it |

Exit 8 is the one to expect when installing scripts: the sanitization pipeline
refused the file and the payload says what to change.

### Consent

Tools an AgentScript declares as \`prompt\` block on a modal in the user's
browser for up to five minutes. That is deliberate and you cannot bypass it. A
script you write yourself cannot grant itself an ungated tool: declaring
\`allow\` in a script installed through this CLI still behaves as \`prompt\`, and
the install warns you when that happens.

### Everything else

\`\`\`sh
customaise --help
\`\`\`
${PRIMER_END}`;
}
