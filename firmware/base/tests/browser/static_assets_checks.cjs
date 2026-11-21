/** @file static_assets_checks.cjs @brief Verify the real module graph, compression and cache boundaries. */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { matchesEtag } = require('./static_assets.cjs');

/** @brief Exercise byte-level HTTP results without a fetch client's automatic decompression. */
async function checkStaticAssets({ createMock }) {
  const mock = createMock();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  const get = (route, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: route, headers }, (response) => {
        const chunks = [];
        response.on('data', (data) => chunks.push(data));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on('error', reject);
    });
  try {
    const index = await get('/', { 'Accept-Encoding': 'identity' });
    assert.equal(index.status, 200);
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.match(index.body.toString(), /<script type="module" src="\/app\.js\?v=[a-f0-9]{24}">/);
    const script = index.body.toString().match(/src="(\/app\.js\?v=[a-f0-9]{24})"/)[1];
    const version = script.split('=')[1];
    const identity = await get(script, { 'Accept-Encoding': 'identity' });
    const compressed = await get(script, { 'Accept-Encoding': 'gzip' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.deepEqual(zlib.gunzipSync(compressed.body), identity.body);
    assert.notEqual(identity.headers.etag, compressed.headers.etag);
    assert.match(compressed.headers['cache-control'], /immutable/);
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    assert.match(identity.body.toString(), new RegExp(`from './modules/core.js\\?v=${version}'`));
    const module = await get(`/modules/core.js?v=${version}`, { 'Accept-Encoding': 'gzip' });
    assert.equal(module.status, 200);
    assert.match(module.headers['content-type'], /javascript/);
    assert.ok(zlib.gunzipSync(module.body).includes(Buffer.from('export function createCoreUI')));
    assert.equal((await get('/modules/missing.js')).status, 404);
    assert.equal((await get('/app.js?v=old')).status, 404);
    assert.equal((await get('/app.js?v=')).status, 404);
    assert.equal((await get(`/app.js?v=${version}&v=old`)).status, 404);
    const excluded = await get(script, { 'Accept-Encoding': 'gzip;q=0, *;q=1' });
    assert.equal(excluded.headers['content-encoding'], undefined);
    assert.deepEqual(excluded.body, identity.body);
    assert.equal((await get(script, { 'Accept-Encoding': '*;q=0' })).status, 406);
    const cached = await get(script, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': `W/${compressed.headers.etag}`,
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(
      (await get(script, { 'Accept-Encoding': 'gzip', 'If-None-Match': identity.headers.etag }))
        .status,
      200,
    );
    assert.equal((await get('/', { 'If-None-Match': index.headers.etag })).status, 304);
    assert.equal(matchesEtag('"a,*,b"', '"actual"'), false);
    assert.equal((await get('/api/v1/config')).headers['cache-control'], 'no-store');

    const repository = path.resolve(__dirname, '../../../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-static-build-'));
    try {
      const files = ['first.h', 'second.h'].map((name) => path.join(directory, name));
      for (const file of files) {
        const result = spawnSync(
          'python3',
          [
            path.join(repository, 'firmware/base/tools/embed_web.py'),
            path.join(repository, 'firmware/base/web'),
            path.join(repository, 'config/product.json'),
            file,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      assert.deepEqual(
        fs.readFileSync(files[0]),
        fs.readFileSync(files[1]),
        'Embedded assets are byte-deterministic',
      );
      assert.match(
        fs.readFileSync(files[0], 'utf8'),
        new RegExp(`web_asset_version\\[\\] = "${version}"`),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    mock.controllers.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}
module.exports = { checkStaticAssets };
