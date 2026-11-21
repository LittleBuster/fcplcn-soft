/** @file Physical-key demo flow through the real local API, coordinator, scenes and virtual PLCs. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

/** Test-only loss of one PLC; the real registry, key transport and other devices keep running. */
function instrumentSecurityEngine(native) {
  const offline = new Set(),
    leases = new Map(),
    commands = [],
    events = [],
    handlers = new Set();
  const engine = {
    ...native,
    snapshot() {
      const snapshot = native.snapshot();
      if (!offline.size) return snapshot;
      return {
        ...snapshot,
        devices: snapshot.devices.map((device) =>
          offline.has(device.id)
            ? {
                ...device,
                online: false,
                status: 'offline',
                controllers: Object.fromEntries(
                  Object.entries(device.controllers).map(([kind, value]) => [
                    kind,
                    { ...value, fresh: false },
                  ]),
                ),
              }
            : device,
        ),
      };
    },
    async command(...args) {
      if (offline.has(args[0]))
        throw Object.assign(new Error('PLC отключён в изолированном тесте'), { statusCode: 503 });
      commands.push({
        at: Date.now(),
        deviceId: args[0],
        kind: args[1],
        itemId: args[2],
        value: args[3],
      });
      return native.command(...args);
    },
    async sendSecurityLease(deviceId, input) {
      if (offline.has(deviceId)) throw new Error('PLC отключён в изолированном тесте');
      const result = await native.sendSecurityLease(deviceId, input);
      leases.set(deviceId, { ...input });
      return result;
    },
    onSecurityTouch(handler) {
      handlers.add(handler);
      const stop = native.onSecurityTouch((event) => {
        events.push(event);
        handler(event);
      });
      return () => {
        handlers.delete(handler);
        stop();
      };
    },
  };
  return {
    engine,
    offline,
    leases,
    commands,
    events,
    replayLast() {
      const event = events.at(-1);
      assert.ok(event);
      for (const handler of handlers) handler({ ...event });
    },
  };
}

/** The browser supplies each physical touch; instrumentation observes the real downstream effects. */
async function checkHouseSecurity({
  page,
  scope = page,
  request,
  harness,
  control,
  artifacts,
  label = 'hub',
  expect,
}) {
  const { demoKeys } = require('../../firmware/base/tests/browser/security_mock.cjs');
  const ids = ['fcplcn-demo-living', 'fcplcn-demo-utility', 'fcplcn-demo-garage'];
  const overview = () => request('/overview').then((reply) => reply.json());
  const data = (snapshot, id, kind) =>
    snapshot.devices.find((device) => device.id === id).controllers[kind].data;
  await scope.locator('[data-nav="overview"]').click();
  await expect(scope.locator('[data-house-security]')).toHaveAttribute('data-house-phase', 'alarm');
  await expect(scope.locator('[data-house-security]')).toHaveClass(/alarm/);
  for (const id of ids) {
    const disarmed = await request(
      '/devices/' + id + '/service/controllers/security/armed',
      { value: false },
      'POST',
    );
    assert.equal(disarmed.status(), 200, await disarmed.text());
    const current = await request('/devices/' + id + '/service/controllers/security').then(
      (reply) => reply.json(),
    );
    const configured = await request(
      '/devices/' + id + '/service/controllers/security',
      {
        baseRevision: current.revision,
        enabled: true,
        sirenRelayId: 'rly-0/16',
        readerPortId: 'sens-0/8',
        entryDelaySeconds: 0,
        exitDelaySeconds: 8,
        keys: [{ id: 'house-key', name: 'Семейная таблетка', address: demoKeys[0] }],
        items: [
          {
            id: 'house-zone',
            name: 'Движение',
            inputId: 'in-0/16',
            sensorType: 'motion',
            entryDelay: false,
          },
        ],
      },
      'POST',
    );
    assert.equal(configured.status(), 200, await configured.text());
  }
  for (const [id, value] of [
    ['home', true],
    ['away', false],
  ]) {
    const definition = (await overview()).scenes.definitions.find((item) => item.id === id);
    const configured = await request(
      '/scenes/' + id,
      {
        baseRevision: definition.revision,
        name: definition.name,
        description: definition.description,
        actions: [
          {
            id: 'contactor',
            deviceId: ids[0],
            controller: 'sockets',
            itemId: 'socket-window',
            value,
          },
        ],
      },
      'PUT',
    );
    assert.equal(configured.status(), 200, await configured.text());
  }
  async function settled(value, onlineIds = ids) {
    await expect
      .poll(
        async () => {
          const snapshot = await overview();
          return (
            snapshot.houseSecurity?.desiredArmed === value &&
            !snapshot.scenes.activeRun &&
            onlineIds.every(
              (id) =>
                snapshot.houseSecurity.devices.find((device) => device.deviceId === id)?.status ===
                'confirmed',
            )
          );
        },
        { timeout: 18000 },
      )
      .toBe(true);
    return overview();
  }
  async function ready(id) {
    await expect
      .poll(
        async () => {
          const state = (await overview()).houseSecurity;
          const lease = harness.leases.get(id);
          return Boolean(
            state && !state.busy && lease && !lease.busy && lease.modeRevision === state.revision,
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
  }
  async function touch(id, value, onlineIds = ids) {
    await ready(id);
    await scope.locator('[data-nav="overview"]').click();
    await scope.locator(`[data-device-id="${id}"]`).click();
    const before = (await overview()).scenes.runs.length,
      eventCount = harness.events.length,
      commandCount = harness.commands.length;
    const response = page.waitForResponse(
      (reply) =>
        reply.url().endsWith('/devices/' + id + '/security/key') &&
        reply.request().method() === 'POST',
    );
    const started = Date.now();
    await scope.locator(`[data-security-demo-touch="${id}"]`).click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    const state = await settled(value, onlineIds);
    assert.equal(
      harness.events.length,
      eventCount + 1,
      'Five held-contact samples emit one physical event',
    );
    assert.equal(
      state.scenes.runs.length,
      before + 1,
      'One touch runs exactly one home/away scenario',
    );
    assert.equal(state.scenes.runs[0].sceneId, value ? 'away' : 'home');
    assert.equal(
      data(state, ids[0], 'sockets').items.find((item) => item.id === 'socket-window').actual,
      !value,
      'The configured contactor action is applied',
    );
    const contactor = harness.commands
      .slice(commandCount)
      .find((command) => command.kind === 'sockets' && command.itemId === 'socket-window');
    assert.ok(
      contactor && contactor.at - started < 3000,
      'Contactor starts immediately without waiting for all PLC confirmations',
    );
    await expect(scope.locator('[data-house-security]')).toHaveAttribute(
      'data-house-mode',
      value ? 'away' : 'home',
    );
    assert.equal(await scope.locator('[data-house-security]').count(), 1);
    assert.equal(
      await scope.locator('.scene-cards .scene-card').count(),
      0,
      'Quick tiles stay on overview',
    );
    return state;
  }
  const baseline = await request('/scenes/home/run', {}, 'POST');
  assert.ok([200, 202].includes(baseline.status()), await baseline.text());
  await settled(false);
  await touch(ids[2], true);
  await expect(scope.locator('[data-house-security]')).toHaveAttribute(
    'data-house-phase',
    'exit_delay',
  );
  await expect(scope.locator('[data-house-security-count]')).toContainText('режим принят');
  await touch(ids[1], false);
  await expect(scope.locator('[data-house-security]')).toHaveAttribute(
    'data-house-phase',
    'stable',
  );
  const beforeReplay = await overview(),
    eventId = beforeReplay.houseSecurity.lastEvent.eventId;
  harness.replayLast();
  harness.replayLast();
  await page.waitForTimeout(1200);
  assert.equal(
    (await overview()).scenes.runs.length,
    beforeReplay.scenes.runs.length,
    'Duplicate delivery never reruns a scenario',
  );
  assert.equal((await overview()).houseSecurity.lastEvent.eventId, eventId);
  harness.offline.add(ids[1]);
  control.houseSecurity.tick();
  for (const value of [true, false, true]) {
    const state = await touch(ids[2], value, [ids[0], ids[2]]);
    assert.equal(
      state.houseSecurity.devices.find((device) => device.deviceId === ids[1]).status,
      'offline',
    );
  }
  const beforeReturn = await overview(),
    commandCount = harness.commands.length;
  harness.offline.delete(ids[1]);
  control.houseSecurity.tick();
  await settled(true);
  const recovered = harness.commands.slice(commandCount);
  assert.ok(
    recovered.some(
      (command) =>
        command.deviceId === ids[1] && command.kind === 'security' && command.value === true,
    ),
    'The returned PLC receives the latest desired mode',
  );
  assert.ok(
    recovered.every((command) => command.kind === 'security' && command.value === true),
    'Recovery never replays historical modes or contactor actions',
  );
  assert.equal(
    (await overview()).scenes.runs.length,
    beforeReturn.scenes.runs.length,
    'Recovery does not rerun scenarios',
  );
  const initialViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(scope.locator('[data-house-security-count]')).toContainText('3 из 3');
  assert.equal(
    await scope.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  if (artifacts)
    await page.screenshot({
      path: path.join(artifacts, label + '-house-security-mobile.png'),
      fullPage: true,
    });
  if (initialViewport) await page.setViewportSize(initialViewport);
  console.log(
    `FCPLCn ${label} house security passed: one physical contact→one all-PLC mode+contactor action, inverse contact, held/duplicate suppression, offline latest-only recovery and mobile status.`,
  );
}

async function standalone() {
  const { chromium, expect } = require('@playwright/test');
  const root = path.resolve(__dirname, '..');
  const module = (file) => import(pathToFileURL(path.join(root, 'dist', file)));
  const [
    { createEngine },
    { Scenes },
    { HubControl },
    { createHubServer },
    { loadConfig, engineOptions },
  ] = await Promise.all([
    module('src/engine.js'),
    module('server/scenes.js'),
    module('server/control.js'),
    module('server/http.js'),
    module('server/config.js'),
  ]);
  const product = JSON.parse(await fs.readFile(path.join(root, '../config/product.json'), 'utf8'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fcplcn-house-browser-'));
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  const config = loadConfig({ FCPLCN_HUB_MODE: 'demo', FCPLCN_HUB_DATA_DIR: directory }, []);
  const native = createEngine(engineOptions(config, product, { labels: {}, onLabelsChanged() {} }));
  const harness = instrumentSecurityEngine(native),
    engine = harness.engine;
  await engine.start();
  const scenes = new Scenes(engine, { directory, demo: true });
  const control = new HubControl({ engine, scenes, product, mode: 'demo', dataDir: directory });
  const server = createHubServer({
    config,
    engine,
    scenes,
    control,
    product,
    webDir: path.join(root, 'dist/web'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const request = (route, body, method = body === undefined ? 'GET' : 'POST') =>
    context.request.fetch(base + '/api/v1' + route, {
      method,
      headers: {
        Origin: base,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { data: body }),
    });
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Войти в хаб' }).click();
    await page.locator('[data-device-id]').first().waitFor();
    await checkHouseSecurity({
      page,
      request,
      harness,
      control,
      artifacts: path.join(root, '.artifacts'),
      expect,
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({
      path: path.join(root, '.artifacts/house-security-failure.png'),
      fullPage: true,
    });
    throw error;
  } finally {
    await browser.close();
    control.close();
    await scenes.stop();
    await engine.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = {
  instrumentSecurityEngine,
  checkHouseSecurity,
  checkLocalHouseSecurity: standalone,
};
if (require.main === module)
  standalone().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
