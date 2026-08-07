import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, networkInterfaces } from 'os';
import { getLanIp } from '@agentdeck/shared';
import { debug } from './logger.js';

const AGENTDECK_DIR = join(homedir(), '.agentdeck');
const TOKEN_FILE = join(AGENTDECK_DIR, 'auth-token');
const TOKEN_LENGTH = 32; // 32 hex chars = 16 bytes

let cachedToken: string | null = null;

/** Read existing token or generate a new one. */
export function getOrCreateToken(): string {
  if (cachedToken) return cachedToken;

  try {
    if (existsSync(TOKEN_FILE)) {
      const token = readFileSync(TOKEN_FILE, 'utf-8').trim();
      if (token.length >= TOKEN_LENGTH) {
        cachedToken = token;
        return token;
      }
    }
  } catch {
    // Fall through to generate
  }

  // Generate new token
  const token = randomBytes(TOKEN_LENGTH / 2).toString('hex');

  try {
    mkdirSync(AGENTDECK_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
    debug('auth', `Generated new auth token → ${TOKEN_FILE}`);
  } catch (err) {
    debug('auth', `Failed to write token file: ${err}`);
  }

  cachedToken = token;
  return token;
}

/** Check if a connection originates from this machine (localhost or own LAN IPs). */
export function isLocalConnection(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;

  // Check if ip matches any of this machine's network interfaces
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.address === ip || `::ffff:${a.address}` === ip) return true;
    }
  }
  return false;
}

/**
 * Replace the stored pairing token with a freshly generated one and return it.
 * Every paired client (companion apps, provisioned ESP32 boards, remote
 * workers) must be re-paired/re-provisioned afterwards — the caller owns
 * telling the user that. Added for issue #145 so a leaked token can be
 * retired without hand-editing the file.
 */
export function rotateToken(): string {
  const token = randomBytes(TOKEN_LENGTH / 2).toString('hex');
  mkdirSync(AGENTDECK_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  cachedToken = token;
  debug('auth', `Rotated auth token → ${TOKEN_FILE}`);
  return token;
}

/** Validate a token string against the stored token. */
export function validateToken(token: string): boolean {
  const stored = getOrCreateToken();
  // Constant-time comparison to prevent timing attacks
  if (token.length !== stored.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return result === 0;
}

/** Build a ws:// URL with auth token for QR code pairing. */
export function getWsUrl(port: number): string {
  const ip = getLanIp();
  const token = getOrCreateToken();
  return `ws://${ip}:${port}?token=${token}`;
}
