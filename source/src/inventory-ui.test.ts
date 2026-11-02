import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/inventory.js', import.meta.url), 'utf8');
const defer = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class Element {
  textContent = ''; value = ''; hidden = false; children: Element[] = [];
  dataset: Record<string, string> = {};
  classList = { remove() {}, add() {}, toggle() {} };
  appendChild(child: Element) { this.children.push(child); return child; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  querySelectorAll() { return []; }
  setAttribute() {} scrollIntoView() {} addEventListener() {}
}
function screen() {
  const elements = new Map<string, Element>();
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: ReturnType<typeof defer>[] = [];
  const context = createContext({
    document: { getElementById: element, createElement: () => new Element(), addEventListener() {}, documentElement: { dataset: {} } },
    window: { matchMedia: () => ({ matches: false }) }, Intl, Date, URLSearchParams,
    api: () => { const request = defer(); requests.push(request); return request.promise; },
  });
  runInContext(source, context);
  return { element, requests, run: (code: string) => runInContext(code, context) as Promise<unknown> };
}
const payload = (units: number) => ({ response: { ok: true }, data: {
  onHandSource: 'airtable', accuracy: { different: 0, missing: 0, unrecorded: 0 }, generatedAt: '2026-11-01T12:00:00Z',
  placeholders: {}, liability: null, totals: { units, rows: 0, unknownCostUnits: units, knownCostUnits: 0, flags: 0, low: 0, overstock: 0, slow: 0, needsReview: 0 },
  thresholds: {}, facets: { games: [], conditions: [], finishes: [] }, rows: [], wantQtyState: 'unread',
} });

test('inventory UI ignores an older filter response after a newer request succeeds', async () => {
  const ui = screen();
  const old = ui.run('load()');
  const fresh = ui.run('load()');
  ui.requests[1]!.resolve(payload(8));
  await fresh;
  assert.equal(ui.element('units').textContent, '8');
  ui.requests[0]!.resolve(payload(10));
  await old;
  assert.equal(ui.element('units').textContent, '8');
});

test('a failed refresh removes stale stock totals and rows; a network failure does the same', async () => {
  const ui = screen();
  let request = ui.run('load()');
  ui.requests[0]!.resolve(payload(8)); await request;
  ui.element('rows').appendChild(new Element());
  request = ui.run('load()');
  ui.requests[1]!.resolve({ response: { ok: false }, data: { error: 'Stock scan incomplete' } }); await request;
  assert.equal(ui.element('units').textContent, '—');
  assert.equal(ui.element('rows').children.length, 0);
  assert.equal(ui.element('detail-body').hidden, true);
  assert.equal(ui.element('inventory-error').textContent, 'Stock scan incomplete');
  request = ui.run('load()');
  ui.requests[2]!.reject(new Error('offline')); await request;
  assert.match(ui.element('inventory-error').textContent, /could not be reached/);
  assert.equal(ui.element('units').textContent, '—');
});

test('closing a stock detail prevents an in-flight response from reopening it', async () => {
  const ui = screen();
  const pending = ui.run("select('rec00000000000001')");
  await ui.run("select('')");
  ui.requests[0]!.resolve({ response: { ok: true }, data: { row: { name: 'Old selection' } } });
  await pending;
  assert.equal(ui.element('detail-body').hidden, true);
  assert.equal(ui.element('detail-name').textContent, 'Card');
});
