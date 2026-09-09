import assert from 'node:assert/strict';
import test from 'node:test';
import Setting, { parseQueryString } from '../server/scripts/modules/utils/setting.mjs';

let stored = '{}';
globalThis.localStorage = {
 getItem: () => stored,
 setItem: (_key, value) => { stored = value; },
};
globalThis.window = { location: { search: '' }, dispatchEvent() {} };
globalThis.document = { querySelector: () => null, getElementById: () => null, addEventListener() {} };

test('kiosk starts enabled without requiring remembered preferences', async () => {
 const { default: settings } = await import('../server/scripts/modules/settings.mjs');
 assert.equal(settings.kiosk.value, true);
 assert.equal(settings.stickyKiosk.value, false);
 settings.stickyKiosk.value = true;
 assert.equal(JSON.parse(stored).kiosk, true);
 settings.stickyKiosk.value = false;
 assert.equal(JSON.parse(stored).kiosk, undefined);
});

test('explicit modern and legacy kiosk URLs override saved preferences', () => {
 for (const key of ['kiosk', 'settings-kiosk-checkbox']) {
  stored = '{"kiosk":true}';
  window.location.search = `?${key}=false`;
  delete parseQueryString.params;
  assert.equal(new Setting('kiosk', { defaultValue: true, sticky: false, stickyRead: true }).value, false);
 }
});

test('remembered kiosk opt-out survives without a URL override', () => {
 stored = '{"kiosk":false}';
 window.location.search = '';
 delete parseQueryString.params;
 assert.equal(new Setting('kiosk', { defaultValue: true, sticky: false, stickyRead: true }).value, false);
});

test('malformed and unavailable settings storage does not prevent initialization', () => {
 for (const value of ['broken json', 'null', '[]']) {
  stored = value;
  assert.equal(new Setting('wide', { defaultValue: false }).value, false);
 }
 const original = globalThis.localStorage;
 globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
 try {
  const setting = new Setting('kiosk', { defaultValue: true });
  setting.value = false;
  assert.equal(setting.value, false);
 } finally {
  globalThis.localStorage = original;
 }
});
