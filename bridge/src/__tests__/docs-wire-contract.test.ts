/**
 * Binds the documented LAN boundary to the code that implements it.
 *
 * `docs/daemon.md` and `docs/wire-compatibility.md` both quote the exact body
 * an unauthenticated LAN peer receives. That payload is the security-relevant
 * one — it is the only thing a stranger on the Wi-Fi can read (issue #145) —
 * and prose drifts silently, so nothing but a test keeps the two honest.
 *
 * If this fails because you added a field to `buildPublicHealth`, stop and ask
 * whether it belongs in front of an unauthenticated peer before updating docs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPublicHealth, gateHttpRequest } from '../http-auth-gate.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** Pull the documented public-health JSON out of a doc's fenced/inline sample. */
function documentedPublicHealth(markdown: string): Record<string, unknown> {
  const match = markdown.match(/\{"status":"ok","mode":"daemon"[^}]*\}/);
  if (!match) throw new Error('no public-health sample found in doc');
  return JSON.parse(match[0]);
}

describe('documented LAN boundary matches the gate', () => {
  it('daemon.md quotes exactly the fields buildPublicHealth emits', () => {
    const documented = documentedPublicHealth(read('docs/daemon.md'));
    expect(Object.keys(documented).sort()).toEqual(Object.keys(buildPublicHealth(9120)).sort());
  });

  it('the documented payload carries no credential, inventory or state', () => {
    const documented = documentedPublicHealth(read('docs/daemon.md'));
    for (const key of Object.keys(documented)) {
      expect(key).not.toMatch(/token|secret|credential|password/i);
    }
    // The fields #145 found leaking, none of which may reappear.
    for (const forbidden of ['pairingToken', 'modules', 'sessions', 'state', 'devices', 'pid']) {
      expect(documented).not.toHaveProperty(forbidden);
    }
  });

  it('GET /health is the only route an unauthorized peer reaches', () => {
    expect(gateHttpRequest('GET', '/health', false)).toBe('public-health');
    for (const route of ['/status', '/sessions', '/timeline', '/devices', '/setup-status', '/sse']) {
      expect(gateHttpRequest('GET', route, false)).toBe('deny');
    }
    // Method matters: only GET reaches the public payload.
    expect(gateHttpRequest('POST', '/health', false)).toBe('deny');
  });
});

describe('wire compatibility contract stays bound to its subjects', () => {
  const doc = read('docs/wire-compatibility.md');

  it('is cataloged in the design system', () => {
    const catalog = JSON.parse(read('agentdeck-design-system/catalog.json'));
    const entry = catalog.documents.find((d: { id: string }) => d.id === 'spec.wire-compatibility');
    expect(entry?.sources?.en).toBe('docs/wire-compatibility.md');
  });

  it('names helpers that still exist, so the id rules stay actionable', () => {
    for (const symbol of ['rawSessionId', 'sameSession']) {
      expect(doc).toContain(symbol);
      expect(read('shared/src/session-utils.ts')).toContain(`export function ${symbol}`);
    }
  });

  it('quotes the retain-on-absent merge shape the rules depend on', () => {
    expect(doc).toContain('s.x = e.x ?? s.x');
  });
});
