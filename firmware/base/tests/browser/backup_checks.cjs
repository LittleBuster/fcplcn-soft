/**
 * @file backup_checks.cjs
 * @brief Verify saved-only backup downloads, restore atomicity, migration, and account changes.
 */
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalBoardId, legacyBoardId } = require('./board_profiles_mock.cjs');
const { demoRoms } = require('./meteo_mock.cjs');

async function checkBackup({ browser, createMock, artifacts }) {
  const source = createMock({
    interactive: true,
    deviceId: 'fcplcn-source',
    mac: '02:11:22:33:44:55',
  });
  const target = createMock({
    interactive: true,
    deviceId: 'fcplcn-target',
    mac: '02:66:77:88:99:AA',
  });
  const sourceContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
  });
  const targetContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-backup-ui-'));
  const errors = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const accountPassword = 'test-account-password';
  const sourcePage = await sourceContext.newPage(),
    page = await targetContext.newPage();
  for (const p of [sourcePage, page]) {
    p.setDefaultTimeout(10000);
    p.on('pageerror', (error) => errors.push(error.message));
    p.on('dialog', (dialog) => dialog.accept());
  }
  const listen = async (mock) => {
    await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${mock.server.address().port}`;
  };
  const upload = async (name, document) => {
    return page.locator('#config-backup-file').setInputFiles({
      name,
      mimeType: 'application/json',
      buffer: Buffer.from(typeof document === 'string' ? document : JSON.stringify(document)),
    });
  };
  let sourceUrl, targetUrl;
  const post = (context, url, endpoint, data) =>
    context.request.post(`${url}/api/v1${endpoint}`, { data });
  try {
    sourceUrl = await listen(source);
    targetUrl = await listen(target);
    assert.equal(
      (await sourceContext.request.get(`${sourceUrl}/api/v1/config/backup`)).status(),
      401,
    );
    await post(sourceContext, sourceUrl, '/login', { username: 'admin', password: '' });
    const settings = {
      baseRevision: 1,
      device: { name: 'Дом Север' },
      wifi: {
        enabled: true,
        ap: {
          enabled: true,
          ssid: 'FCPLCn Saved AP',
          password: 'test-ap-password',
          channel: 6,
          ip: '192.168.4.1',
          netmask: '255.255.255.0',
        },
        sta: { enabled: true, ssid: 'Saved router', password: 'test-wifi-password' },
      },
      ethernet: {
        enabled: true,
        dhcp: false,
        ip: '192.168.2.44',
        netmask: '255.255.255.0',
        gateway: '192.168.2.1',
        dns: '1.1.1.1',
      },
      linux: {
        host: 'hub.example.test',
        port: 2883,
        username: 'mqtt-owner',
        password: 'test-mqtt-password',
      },
      time: { timezone: 'UTC-3', ntpEnabled: true, ntpServer: 'ntp.example.test' },
    };
    assert.equal((await post(sourceContext, sourceUrl, '/config', settings)).status(), 200);
    // HTTP chunks may split a UTF-8 character; byte collection must precede
    // decoding, otherwise a saved Cyrillic name is silently corrupted.
    const body = Buffer.from(
      JSON.stringify({ baseRevision: source.config.revision, device: settings.device }),
    );
    const split = body.indexOf(Buffer.from('Д')) + 1;
    const cookies = (await sourceContext.storageState()).cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    const chunkStatus = await new Promise((resolve, reject) => {
      const request = http.request(
        `${sourceUrl}/api/v1/config`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('Chunked JSON timeout')));
      request.write(body.subarray(0, split));
      setTimeout(() => request.end(body.subarray(split)), 5);
    });
    assert.equal(chunkStatus, 200);
    assert.equal(source.config.device.name, 'Дом Север');
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/controllers/sockets', {
          baseRevision: 1,
          enabled: true,
          items: [
            { id: 'backup-kitchen', name: 'Кухня', relayId: 'rly-0/1', inputId: '' },
            { id: 'backup-lamp', name: 'Лампа', relayId: 'rly-0/2', inputId: 'in-0/1' },
          ],
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/controllers/sockets/state', {
          id: 'backup-kitchen',
          value: true,
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/controllers/lights', {
          baseRevision: 1,
          enabled: true,
          items: [{ id: 'backup-light', name: 'Свет', relayId: 'rly-0/3', inputId: 'in-0/2' }],
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/controllers/lights/state', {
          id: 'backup-light',
          value: true,
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/controllers/meteo', {
          baseRevision: 1,
          enabled: true,
          items: [
            {
              id: 'backup-dht',
              name: 'Воздух',
              portId: 'sens-0/1',
              sensorType: 'dht22',
              address: '',
            },
            {
              id: 'backup-ds',
              name: 'Бак',
              portId: 'sens-0/2',
              sensorType: 'onewire',
              address: demoRoms('sens-0/2')[0],
            },
          ],
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/controllers/thermostats', {
          baseRevision: 1,
          enabled: true,
          items: [
            {
              id: 'backup-heat',
              name: 'Отопление',
              meteoId: 'backup-dht',
              relayId: 'rly-0/4',
              inputId: 'in-0/3',
              mode: 'heating',
              setpointC: 24,
              hysteresisC: 1,
            },
            {
              id: 'backup-disabled',
              name: 'Выключенный термостат',
              meteoId: 'backup-dht',
              relayId: 'rly-0/5',
              inputId: '',
              mode: 'cooling',
              setpointC: 25,
              hysteresisC: 2,
            },
          ],
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/controllers/thermostats/enabled', {
          id: 'backup-heat',
          value: true,
        })
      ).status(),
      200,
    );
    source.setMeteoTemperature('backup-dht', 20);
    source.controllers.advanceThermostatTime(60001);
    assert.equal(source.thermostats.snapshot().items[0].state, true);
    assert.equal(
      (
        await post(sourceContext, sourceUrl, '/user', {
          currentPassword: '',
          username: 'owner',
          newPassword: accountPassword,
        })
      ).status(),
      200,
    );

    await sourcePage.goto(sourceUrl);
    await sourcePage.locator('#login-username').fill('owner');
    await sourcePage.locator('#login-password').fill(accountPassword);
    await sourcePage.locator('#login-form button').click();
    await sourcePage.locator('#app-view').waitFor({ state: 'visible' });
    await sourcePage.locator('#tab-system').click();
    assert.equal(await sourcePage.locator('#device-name').inputValue(), 'Дом Север');
    assert.equal(
      source.backupRequests,
      0,
      'Opening System never downloads credentials automatically',
    );
    await sourcePage.locator('#device-name').fill('Не сохранено');
    await sourcePage.locator('#time-timezone').fill('UTC-5');
    const downloadEvent = sourcePage.waitForEvent('download');
    await sourcePage.locator('#config-backup-download').click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'FCPLCn-Дом-Север-config.json');
    const file = path.join(directory, 'export.json');
    await download.saveAs(file);
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(document.boardId, canonicalBoardId);
    assert.equal(document.version, 10);
    assert.equal(document.config.hardware.boardId, canonicalBoardId);
    assert.equal(source.backupRequests, 1);
    assert.equal(
      document.config.device.name,
      'Дом Север',
      'Export uses saved settings rather than drafts',
    );
    assert.equal(document.config.time.timezone, 'UTC-3');
    assert.equal(await sourcePage.locator('#device-name').inputValue(), 'Не сохранено');
    assert.equal(document.config.wifi.ap.password, settings.wifi.ap.password);
    assert.equal(document.config.wifi.sta.password, settings.wifi.sta.password);
    assert.equal(document.config.linux.password, settings.linux.password);
    assert.equal(document.user.username, 'owner');
    assert.equal(document.user.algorithm, 'PBKDF2-HMAC-SHA256');
    assert.equal(
      crypto
        .pbkdf2Sync(
          accountPassword,
          Buffer.from(document.user.salt, 'hex'),
          document.user.iterations,
          32,
          'sha256',
        )
        .toString('hex'),
      document.user.hash,
    );
    assert.equal(
      JSON.stringify(document).includes(accountPassword),
      false,
      'Backup includes verifier, never plaintext web password',
    );
    assert.equal(
      'revision' in document.config ||
        'user' in document.config ||
        'passwordSet' in document.config.wifi.ap,
      false,
    );
    assert.deepEqual(
      document.controllers.sockets.items.map((item) => item.state),
      [true, false],
    );
    assert.deepEqual(
      document.controllers.lights.items.map((item) => item.state),
      [true],
    );
    assert.equal(document.controllers.meteo.items[1].address, demoRoms('sens-0/2')[0]);
    assert.deepEqual(
      document.controllers.thermostats.items.map((item) => item.enabled),
      [true, false],
    );
    assert.equal(document.controllers.thermostats.items[0].inputId, 'in-0/3');

    await page.goto(targetUrl);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-system').click();
    assert.equal(
      (
        await post(targetContext, targetUrl, '/controllers/meteo', {
          baseRevision: 1,
          enabled: true,
          items: [
            {
              id: 'old-temperature',
              name: 'Старый источник',
              portId: 'sens-0/8',
              sensorType: 'dht22',
              address: '',
            },
          ],
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(targetContext, targetUrl, '/controllers/thermostats', {
          baseRevision: 1,
          enabled: true,
          items: [
            {
              id: 'old-heat',
              name: 'Старое отопление',
              meteoId: 'old-temperature',
              relayId: 'rly-0/16',
              mode: 'heating',
              setpointC: 25,
              hysteresisC: 1,
            },
          ],
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(targetContext, targetUrl, '/controllers/thermostats/enabled', {
          id: 'old-heat',
          value: true,
        })
      ).status(),
      200,
    );
    target.setMeteoTemperature('old-temperature', 20);
    target.controllers.advanceThermostatTime(60001);
    assert.equal(target.thermostats.snapshot().items[0].actual, true);
    assert.equal(
      (
        await post(targetContext, targetUrl, '/controllers/sockets', {
          baseRevision: 1,
          enabled: true,
          items: [{ id: 'old-socket', name: 'Старая розетка', relayId: 'rly-0/15', inputId: '' }],
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await post(targetContext, targetUrl, '/controllers/sockets/state', {
          id: 'old-socket',
          value: true,
        })
      ).status(),
      200,
    );
    const before = await (
      await targetContext.request.get(`${targetUrl}/api/v1/config/backup`)
    ).json();
    const beforeRevision = target.config.revision;
    async function unchanged() {
      assert.deepEqual(
        await (await targetContext.request.get(`${targetUrl}/api/v1/config/backup`)).json(),
        before,
      );
      assert.equal(target.config.revision, beforeRevision);
      assert.equal(target.restorePending, false);
      assert.equal(target.rebootCount, 0);
    }
    async function reject(change, status) {
      const invalid = clone(document);
      change(invalid);
      assert.equal(
        (
          await post(targetContext, targetUrl, '/config/restore', {
            baseRevision: beforeRevision,
            document: invalid,
          })
        ).status(),
        status,
      );
      await unchanged();
    }
    await reject((doc) => {
      doc.boardId = doc.config.hardware.boardId = 'wrong-board';
    }, 409);
    await reject((doc) => {
      doc.version = 11;
    }, 400);
    await reject((doc) => {
      delete doc.controllers.thermostats.items[0].enabled;
    }, 400);
    await reject((doc) => {
      doc.controllers.thermostats.items[0].minOnSeconds = 60;
    }, 400);
    await reject((doc) => {
      doc.controllers.thermostats.items[0].minOffSeconds = 86401;
    }, 400);
    for (const invalid of ['missing', 'range'])
      await reject((doc) => {
        doc.version = 6;
        delete doc.controllers.irrigation;
        delete doc.controllers.tanks;
        delete doc.controllers.security;
        for (const item of doc.controllers.thermostats.items) {
          item.minOnSeconds = 2;
          item.minOffSeconds = 180;
        }
        if (invalid === 'missing') delete doc.controllers.thermostats.items[0].minOnSeconds;
        else doc.controllers.thermostats.items[0].minOffSeconds = 86401;
      }, 400);
    await reject((doc) => {
      delete doc.controllers.thermostats.items[0].inputId;
    }, 400);
    await reject((doc) => {
      doc.controllers.thermostats.items[0].inputId = doc.controllers.sockets.items[1].inputId;
    }, 400);
    await reject((doc) => {
      delete doc.controllers.meteo;
    }, 400);
    await reject((doc) => {
      delete doc.controllers.thermostats;
    }, 400);
    assert.equal(
      'state' in document.controllers.thermostats.items[0],
      false,
      'Automatic demand is never exported as durable state',
    );
    await reject((doc) => {
      doc.controllers.meteo.items[1].address = '2800000000000001';
    }, 400);
    await reject((doc) => {
      delete doc.controllers.lights;
    }, 400);
    await reject((doc) => {
      doc.controllers.lights.items[0].relayId = doc.controllers.sockets.items[0].relayId;
    }, 400);
    await reject((doc) => {
      doc.controllers.lights.items[0].inputId = doc.controllers.sockets.items[1].inputId;
    }, 400);
    await reject((doc) => {
      doc.product = 'Other';
    }, 400);
    await reject((doc) => {
      delete doc.config.time;
    }, 400);
    await reject((doc) => {
      doc.controllers.unknown = {};
    }, 400);
    await reject((doc) => {
      doc.config.device.unknown = true;
    }, 400);
    await reject((doc) => {
      doc.controllers.sockets.items[0].relayId = 'rly-0/99';
    }, 400);
    await reject((doc) => {
      doc.config.wifi.enabled = 'true';
    }, 400);
    await reject((doc) => {
      doc.user.iterations = 10;
    }, 400);
    await reject((doc) => {
      doc.sourceDeviceId = 'x'.repeat(33000);
    }, 413);
    assert.equal(
      (
        await targetContext.request.post(`${targetUrl}/api/v1/config/restore`, {
          headers: { 'Content-Type': 'application/json' },
          data: Buffer.from('{broken'),
        })
      ).status(),
      400,
    );
    await unchanged();
    target.setFaults({ restore: 'Test atomic storage failure' });
    assert.equal(
      (
        await post(targetContext, targetUrl, '/config/restore', {
          baseRevision: beforeRevision,
          document,
        })
      ).status(),
      503,
    );
    await unchanged();
    target.setFaults({ restore: '' });
    assert.equal(
      (
        await post(targetContext, targetUrl, '/config/restore', { baseRevision: 999, document })
      ).status(),
      409,
    );
    await unchanged();

    const requestsBeforeFile = target.restoreRequests;
    await upload('broken.json', '{broken');
    await page.locator('#config-backup-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#config-backup-preview').isVisible(), false);
    assert.equal(target.restoreRequests, requestsBeforeFile);
    await upload('huge.json', 'x'.repeat(33000));
    await page.locator('#config-backup-error').waitFor({ state: 'visible' });
    assert.equal(target.restoreRequests, requestsBeforeFile);
    const wrongProfile = clone(document);
    wrongProfile.boardId = wrongProfile.config.hardware.boardId = 'wrong-board';
    await upload('wrong-board.json', wrongProfile);
    await page.locator('#config-backup-profile-warning').waitFor({ state: 'visible' });
    const mismatch = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/config/restore'),
    );
    await page.locator('#config-backup-restore').click();
    assert.equal((await mismatch).status(), 409);
    await unchanged();
    const legacyDocument = clone(document);
    legacyDocument.boardId = legacyBoardId;
    legacyDocument.config.hardware.boardId = legacyBoardId;
    assert.notEqual(
      legacyDocument.boardId,
      canonicalBoardId,
      'This fixture deliberately remains a legacy backup',
    );
    await upload('legacy-source-config.json', legacyDocument);
    await page.locator('#config-backup-preview').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('#config-backup-profile-warning').isVisible(),
      false,
      'Registered legacy alias is the same active profile',
    );
    assert.match(
      await page.locator('#config-backup-profile').textContent(),
      /FCPLCN-161608-1v0.*fcplcn-161608-1v0/,
    );
    assert.match(await page.locator('#config-backup-device').textContent(), /Дом Север/);
    const previewText = await page.locator('#config-backup-preview').textContent();
    for (const secret of [
      settings.wifi.ap.password,
      settings.wifi.sta.password,
      settings.linux.password,
      document.user.hash,
      document.user.salt,
    ])
      assert.equal(previewText.includes(secret), false);
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'backup-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'backup-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Backup preview mobile overflow',
    );
    const restored = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/config/restore'),
    );
    await page.locator('#config-backup-restore').click();
    const acceptedRestore = await restored;
    assert.equal(acceptedRestore.status(), 200);
    assert.equal(
      acceptedRestore.request().postDataJSON().document.boardId,
      legacyBoardId,
      'Browser sends the original legacy document; server owns migration',
    );
    assert.equal(target.restorePending, true);
    assert.equal(
      target.config.device.name,
      'FCPLCn',
      'Runtime waits for the scheduled atomic boot',
    );
    assert.equal(target.hardware.snapshot().relays[0].value, false, 'No early ON before reboot');
    assert.equal(
      target.hardware.snapshot().relays[15].value,
      false,
      'Accepted restore immediately turns the previous thermostat OFF',
    );
    assert.equal(
      target.hardware.snapshot().relays[14].value,
      true,
      'Ordinary socket state remains unchanged during the pending interval',
    );
    target.controllers.tick(Date.now() + 10000);
    assert.equal(
      target.hardware.snapshot().relays[15].value,
      false,
      'Pending restore cannot turn the thermostat back ON',
    );
    assert.equal(
      target.rebootRequests,
      0,
      'Restore schedules its own reboot without a second API request',
    );
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await page.waitForTimeout(1150);
    assert.equal(
      (
        await post(targetContext, targetUrl, '/login', { username: 'admin', password: '' })
      ).status(),
      401,
    );
    assert.equal(await page.locator('#login-username').inputValue(), 'owner');
    await page.locator('#login-password').fill(accountPassword);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    const after = await (
      await targetContext.request.get(`${targetUrl}/api/v1/config/backup`)
    ).json();
    assert.equal(after.boardId, canonicalBoardId, 'Next export uses the canonical profile ID');
    assert.equal(after.config.hardware.boardId, canonicalBoardId);
    assert.deepEqual(after.config, document.config);
    assert.deepEqual(after.user, document.user);
    assert.deepEqual(after.controllers, document.controllers);
    const publicConfig = await (
      await targetContext.request.get(`${targetUrl}/api/v1/config`)
    ).json();
    for (const secret of [
      accountPassword,
      settings.wifi.ap.password,
      settings.wifi.sta.password,
      settings.linux.password,
    ])
      assert.equal(JSON.stringify(publicConfig).includes(secret), false);
    const status = await (await targetContext.request.get(`${targetUrl}/api/v1/status`)).json();
    assert.equal(status.device.id, 'fcplcn-target');
    assert.equal(status.device.mac, '02:66:77:88:99:AA');
    assert.equal(status.device.name, 'Дом Север');
    assert.equal(after.sourceDeviceId, 'fcplcn-target');
    assert.equal(target.hardware.snapshot().relays[0].value, true);
    assert.equal(target.hardware.snapshot().relays[1].value, false);
    assert.equal(target.hardware.snapshot().relays[2].value, true);
    await page.locator('#tab-system').click();
    assert.equal(await page.locator('#device-name').inputValue(), 'Дом Север');
    assert.equal(
      (
        await post(targetContext, targetUrl, '/config', {
          baseRevision: target.config.revision,
          device: { name: 'я'.repeat(33) },
        })
      ).status(),
      400,
    );
    // A true v1 file contains sockets only and deliberately resets the newer
    // module to empty/OFF, preserving the legacy socket states and aliases.
    for (const version of [7, 6, 5, 4, 3, 2, 1]) {
      const legacy = clone(document);
      legacy.version = version;
      delete legacy.controllers.irrigation;
      delete legacy.controllers.tanks;
      if (version < 8) delete legacy.controllers.security;
      legacy.boardId = legacyBoardId;
      legacy.config.hardware.boardId = legacyBoardId;
      if (version < 4) delete legacy.controllers.thermostats;
      else
        for (const item of legacy.controllers.thermostats.items) {
          if (version === 4) {
            delete item.enabled;
            delete item.inputId;
          }
          if (version === 6) {
            item.minOnSeconds = 2;
            item.minOffSeconds = 180;
          } else {
            delete item.minOnSeconds;
            delete item.minOffSeconds;
          }
        }
      if (version < 3) delete legacy.controllers.meteo;
      if (version === 1) delete legacy.controllers.lights;
      await page.locator('#tab-system').click();
      await upload(`legacy-v${version}.json`, legacy);
      await page.locator('#config-backup-preview').waitFor({ state: 'visible' });
      const response = page.waitForResponse((response) =>
        response.url().endsWith('/api/v1/config/restore'),
      );
      await page.locator('#config-backup-restore').click();
      assert.equal((await response).status(), 200);
      await page.waitForTimeout(1150);
      await page.locator('#login-password').fill(accountPassword);
      await page.locator('#login-form button').click();
      await page.locator('#app-view').waitFor({ state: 'visible' });
      const migrated = await (
        await targetContext.request.get(`${targetUrl}/api/v1/config/backup`)
      ).json();
      assert.equal(migrated.version, 10);
      assert.deepEqual(migrated.controllers.sockets, document.controllers.sockets);
      assert.deepEqual(
        migrated.controllers.meteo,
        version < 3 ? { enabled: false, items: [] } : document.controllers.meteo,
      );
      assert.deepEqual(
        migrated.controllers.thermostats,
        version < 4
          ? { enabled: false, items: [] }
          : {
              ...document.controllers.thermostats,
              items: document.controllers.thermostats.items.map((item) => ({
                ...item,
                inputId: version === 4 ? '' : item.inputId,
                enabled: version === 4 ? true : item.enabled,
              })),
            },
      );
      assert.deepEqual(
        migrated.controllers.lights,
        version === 1 ? { enabled: false, items: [] } : document.controllers.lights,
      );
    }
    assert.equal(target.hardware.snapshot().relays[2].value, false);
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn backup browser checks passed: saved-only download, private secrets/verifier, legacy-alias to canonical roundtrip, full second-device restore, target identity, atomic rejection/profile/CAS/storage errors, own reboot, redacted normal API, mobile.',
    );
  } finally {
    await sourceContext.close();
    await targetContext.close();
    for (const mock of [source, target]) {
      mock.server.closeAllConnections();
      await new Promise((resolve) => mock.server.close(resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { checkBackup };
