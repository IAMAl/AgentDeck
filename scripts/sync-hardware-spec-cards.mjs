#!/usr/bin/env node
// Render the ESP32 board specification sheet from its canonical Markdown table
// (docs/hardware-compatibility.md) into the public Devices page as responsive
// spec cards.
//
//   node scripts/sync-hardware-spec-cards.mjs           # write
//   node scripts/sync-hardware-spec-cards.mjs --check    # CI drift gate
//
// The Markdown table is the single source of truth. Never hand-edit the block
// between SPEC-CARDS:BEGIN and SPEC-CARDS:END.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'docs/hardware-compatibility.md');
const TARGET = resolve(ROOT, 'docs/hardware/index.html');
const HEADING = '## ESP32 board specification sheet';
const BEGIN = '<!-- SPEC-CARDS:BEGIN (generated from docs/hardware-compatibility.md by scripts/sync-hardware-spec-cards.mjs — do not edit by hand) -->';
const END = '<!-- SPEC-CARDS:END -->';

const EXPECTED_COLUMNS = [
  'Board',
  '`device_info.board` · env',
  'SoC',
  'Flash · PSRAM',
  'Display',
  'Controller',
  'Input',
  'Notable peripherals',
  'Host link',
  'OTA slot',
  'Status',
];

/** Split one Markdown table row into trimmed cells. */
function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseSpecTable(markdown) {
  const start = markdown.indexOf(HEADING);
  if (start === -1) throw new Error(`Heading not found in ${SOURCE}: ${HEADING}`);
  const after = markdown.slice(start + HEADING.length);
  const nextHeading = after.search(/\n## /);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);

  const lines = section.split('\n');
  const headerIndex = lines.findIndex((l) => l.trim().startsWith('|') && l.includes('Board'));
  if (headerIndex === -1) throw new Error('Specification table not found under the heading.');

  const header = splitRow(lines[headerIndex]);
  const mismatch = EXPECTED_COLUMNS.filter((c, i) => header[i] !== c);
  if (header.length !== EXPECTED_COLUMNS.length || mismatch.length) {
    throw new Error(
      `Unexpected table columns.\n  expected: ${EXPECTED_COLUMNS.join(' | ')}\n  actual:   ${header.join(' | ')}`,
    );
  }

  const rows = [];
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    if (cells.length !== EXPECTED_COLUMNS.length) {
      throw new Error(`Row ${rows.length + 1} has ${cells.length} cells, expected ${EXPECTED_COLUMNS.length}.`);
    }
    rows.push(Object.fromEntries(EXPECTED_COLUMNS.map((key, idx) => [key, cells[idx]])));
  }
  if (!rows.length) throw new Error('Specification table has no rows.');
  return rows;
}

const escapeHtml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Render inline Markdown code spans; escape everything else. */
function inline(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

const isBlank = (value) => !value || value === '—' || value === '-';

function renderCard(row) {
  const board = row.Board;
  const status = row.Status;
  // Badge variants mirror the Devices page: kelp for first-party firmware,
  // dark for the community fork, amber for hardware with no build yet.
  const badgeClass =
    status === 'Shipping' ? 'native' : status === 'Community fork' ? 'bridge' : 'experimental';

  // Identity line: firmware name + env for shipping boards, provenance otherwise.
  const identity = isBlank(row['`device_info.board` · env'])
    ? 'Vendor factory firmware · no AgentDeck build yet'
    : inline(row['`device_info.board` · env']);

  const specs = [
    ['SoC', row.SoC],
    ['Memory', row['Flash · PSRAM']],
    ['Display', row.Display],
    ['Controller', row.Controller],
    ['Input', row.Input],
    ['Host link', row['Host link']],
    ['OTA slot', row['OTA slot']],
  ]
    .map(
      ([label, value]) =>
        `<div class="spec"><span>${escapeHtml(label)}</span><strong>${inline(isBlank(value) ? '—' : value)}</strong></div>`,
    )
    .join('');

  const peripherals = isBlank(row['Notable peripherals'])
    ? ''
    : `\n        <p class="periph"><span>Peripherals</span>${inline(row['Notable peripherals'])}</p>`;

  return `      <article class="device spec-card">
        <div class="device-top"><h3>${escapeHtml(board)}</h3><span class="badge ${badgeClass}">${escapeHtml(status)}</span></div>
        <p class="sub">${identity}</p>${peripherals}
        <div class="specs">${specs}</div>
      </article>`;
}

function renderBlock(rows) {
  const count = (status) => rows.filter((r) => r.Status === status).length;
  const shipping = count('Shipping');
  const fork = count('Community fork');
  const evaluation = count('Evaluation');
  return [
    BEGIN,
    `    <div class="grid spec-grid">`,
    rows.map(renderCard).join('\n'),
    `    </div>`,
    `    <p class="spec-note"><strong>${rows.length} boards</strong> — ${shipping} running AgentDeck firmware, ${fork} on the community CrossPoint fork, ${evaluation} on hand for evaluation. Ordered by overall capability: SoC class, then memory, then panel, then peripheral breadth. Evaluation boards are not counted as surfaces and carry no compatibility claim.</p>`,
    `    ${END}`,
  ].join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const rows = parseSpecTable(readFileSync(SOURCE, 'utf8'));
  const html = readFileSync(TARGET, 'utf8');

  const beginAt = html.indexOf(BEGIN);
  const endAt = html.indexOf(END);
  if (beginAt === -1 || endAt === -1) {
    console.error(`sync-hardware-spec-cards: markers missing in ${TARGET}.`);
    process.exit(1);
  }

  const before = html.slice(0, beginAt);
  const after = html.slice(endAt + END.length);
  const next = `${before}${renderBlock(rows)}${after}`;

  if (next === html) {
    console.log(`sync-hardware-spec-cards: ${rows.length} board(s) in sync.`);
    return;
  }
  if (check) {
    console.error(
      'sync-hardware-spec-cards: docs/hardware/index.html is out of sync with docs/hardware-compatibility.md.\n' +
        'Run: node scripts/sync-hardware-spec-cards.mjs',
    );
    process.exit(1);
  }
  writeFileSync(TARGET, next);
  console.log(`sync-hardware-spec-cards: rendered ${rows.length} board(s) into docs/hardware/index.html.`);
}

main();
