/**
 * Exit codes — the CLI's contract with an agent driving it.
 *
 * These exist because "it failed" is not actionable. An agent that cannot
 * tell "you are out of quota" from "Chrome is closed" retries into a wall,
 * and the retry is the worst possible behaviour at exactly the moment we
 * are asking someone to upgrade.
 *
 * The discriminator is `structuredContent.error.type` from the tool
 * envelope, never the message text and never the numeric JSON-RPC code.
 * An error thrown from a tool handler reaches a client with its code and
 * data stripped, so the type string is the only thing that survives.
 */

export const EXIT = {
  OK: 0,
  /** Usage error: unknown verb, missing argument, bad JSON. */
  USAGE: 2,
  /** The daemon or the extension is not reachable. Do not retry blindly. */
  UNAVAILABLE: 3,
  /** Signed out. Tell the user to sign in; retrying will not help. */
  AUTH: 4,
  /** Free-tier cap reached. Stop. Surface the upgrade path. */
  CAP: 5,
  /**
   * A person's decision, not a fault: the person denied consent, or only
   * they can make this change (Script Decisions `person_required`). Do not
   * retry; tell the person what the message asks of them.
   */
  DENIED: 6,
  /** Consent expired unanswered. May retry once, with the user told why. */
  TIMEOUT: 7,
  /**
   * Customaise was reached and Customaise said no: a script the sanitization
   * pipeline refused, most often. Distinct from 1 because it is actionable
   * and self-inflicted. The diagnostics in the payload say what to change,
   * and rewriting the input is the correct response, where a 1 means
   * something broke and rewriting the input will not help.
   */
  REJECTED: 8,
  /** Anything else. */
  ERROR: 1,
} as const;

/** Map a tool envelope's error type to the code an agent branches on. */
export function exitCodeForErrorType(type: string | undefined): number {
  switch (type) {
    // The call itself was malformed: a missing id, a wrong type. Same
    // posture as a CLI usage error, because it is one, just caught a layer
    // further in than the argument parser could reach.
    case 'invalid_argument':       return EXIT.USAGE;
    case 'auth_required':          return EXIT.AUTH;
    case 'cap_exceeded':
    case 'rate_limit':             return EXIT.CAP;
    case 'extension_not_connected':
    case 'extension_disconnected':
    // The leader process died under a follower. Same posture as the
    // extension being gone: something upstream is down, retrying the
    // same call changes nothing. Kept distinct from the extension cases
    // only so a log says which link of the chain broke.
    case 'leader_unreachable':
    case 'extension_unreachable':
    case 'extension_outdated':
    case 'permission_resolution_failed':
    case 'tool_registration_timeout':
    case 'tool_document_changed':
    // Script Decisions could not confirm the outcome (`connection_uncertain`,
    // or a code this build does not name). Something upstream is uncertain,
    // so the next step is reading the state again, not repeating the change.
    case 'service_unavailable':
    case 'dispatch_timeout':       return EXIT.UNAVAILABLE;
    // Emitted by the CLI itself for a payload-level `success: false`, so the
    // map has to know it: we publish this string in our own JSON, and a
    // caller round-tripping it through here must not land on 1.
    // The target does not exist. Distinct from a malformed call: the shape
    // was fine, the thing named was not there. Re-list and pick a real one.
    case 'not_found':              return EXIT.REJECTED;
    case 'rejected':               return EXIT.REJECTED;
    case 'consent_denied':         return EXIT.DENIED;
    // Only the person can make this change: turning on Script Decisions for
    // agents, a runaway-loop pause, keys, this device's access, a shared
    // script. Same posture as a denial: no retry succeeds until the person
    // acts, and the message names what they do.
    case 'person_required':        return EXIT.DENIED;
    case 'consent_timeout':        return EXIT.TIMEOUT;
    // Neither a decision nor a timeout: the request was withdrawn, either by
    // this caller aborting or by the gate tearing down pending consents.
    // Deliberately generic, because there is nothing for an agent to do
    // differently: whoever cancelled it already knows.
    case 'consent_cancelled':      return EXIT.ERROR;
    default:                       return EXIT.ERROR;
  }
}
