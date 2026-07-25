/**
 * Restore a device-truncated session id to the full roster id.
 *
 * Device clients with fixed-width id buffers (ESP32 `SessionInfo.id[32]`)
 * receive session ids capped to 31 chars by `prepareForSerial` — but observed
 * session ids (`observed:claude:<uuid>`, 52 chars) are longer than that. When
 * such a client echoes the truncated id back in `session_command` /
 * `select_option` / `focus_session`, an exact-match lookup silently drops the
 * command — worse, the `observed:claude:` steering branch would queue state
 * under a truncated uuid that no hook ever reads.
 *
 * Resolution: exact match wins; otherwise the raw id must be the prefix of
 * exactly ONE known id (uuid prefixes make collisions practically impossible;
 * an ambiguous prefix stays unresolved rather than guessing).
 */
export function resolveSessionIdPrefix(raw: string, knownIds: Iterable<string>): string {
  if (!raw) return raw;
  const ids = new Set<string>();
  for (const id of knownIds) if (typeof id === 'string' && id) ids.add(id);
  if (ids.has(raw)) return raw;
  let match: string | null = null;
  for (const id of ids) {
    if (id.startsWith(raw)) {
      if (match !== null) return raw; // ambiguous — keep as-is
      match = id;
    }
  }
  return match ?? raw;
}
