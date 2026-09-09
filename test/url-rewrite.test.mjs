import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteUrl } from '../server/scripts/modules/utils/url-rewrite.mjs';

globalThis.window = { location: { protocol: 'http:', host: 'localhost:8080' } };

test('weather services always use the Express proxy without a capability flag', () => {
 for (const [host, prefix] of [
  ['api.weather.gov', 'api'], ['forecast.weather.gov', 'forecast'],
  ['www.spc.noaa.gov', 'spc'], ['radar.weather.gov', 'radar'],
  ['mesonet.agron.iastate.edu', 'mesonet'],
 ]) {
  assert.equal(rewriteUrl(`https://${host}/example?a=1`).href, `http://localhost:8080/${prefix}/example?a=1`);
 }
});

test('proxy rewriting preserves unrelated services and relative asset URLs', () => {
 assert.equal(rewriteUrl('https://geocode.arcgis.com/example').href, 'https://geocode.arcgis.com/example');
 assert.equal(rewriteUrl('/data/stations.json'), '/data/stations.json');
 const original = new URL('https://api.weather.gov/points/1,2');
 rewriteUrl(original);
 assert.equal(original.host, 'api.weather.gov');
});
