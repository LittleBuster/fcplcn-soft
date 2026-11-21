/** @file Verify the shared PLC firmware uploader locally and through the authenticated hub. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium, expect } = require('@playwright/test');

const repository = path.resolve(__dirname, '../..');
const binaryPath = path.join(repository, 'firmware/base/dist/FCPLCn.bin');

/** @brief Use the real release when built, with a valid ESP fixture for a fresh hub-only checkout. */
async function releaseImage() {
  try {
    return await fs.readFile(binaryPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const bytes = Buffer.alloc(16032);
    bytes[0] = 0xe9;
    bytes[1] = 1;
    bytes.writeUInt16LE(9, 12);
    bytes[23] = 1;
    bytes.writeUInt32LE(0x3c000020, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.fill(0x19, 288);
    bytes.writeUInt32LE(0xabcd5432, 32);
    bytes.write('ota-browser-check', 48);
    bytes.write('FCPLCn', 80);
    crypto.createHash('sha256').update('firmware-browser-elf').digest().copy(bytes, 176);
    let checksum = 0xef;
    for (const byte of bytes.subarray(32)) checksum ^= byte;
    const padding = Buffer.alloc(16);
    padding[15] = checksum;
    const body = Buffer.concat([bytes, padding]);
    return Buffer.concat([body, crypto.createHash('sha256').update(body).digest()]);
  }
}

/** @brief Check the LAN-compatible hash implementation against independent standard-library results. */
async function checkImageHelpers() {
  const source = await fs.readFile(
    path.join(repository, 'firmware/base/web/modules/firmware.js'),
    'utf8',
  );
  const { firmwareSha256, inspectFirmware } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1024 * 1024]) {
    const bytes = Buffer.alloc(length, 0x61);
    assert.equal(
      firmwareSha256(bytes),
      crypto.createHash('sha256').update(bytes).digest('hex'),
      `SHA256 length ${length}`,
    );
  }
  const image = await releaseImage();
  assert.equal(firmwareSha256(image), crypto.createHash('sha256').update(image).digest('hex'));
  assert.ok(inspectFirmware(image).version);
  assert.throws(() => inspectFirmware(Buffer.alloc(512)), /бинарник приложения/);
  const wrongChip = Buffer.from(image);
  wrongChip.writeUInt16LE(0, 12);
  assert.throws(() => inspectFirmware(wrongChip), /ESP32-S3/);
  const foreign = Buffer.from(image);
  foreign.fill(0, 80, 112);
  foreign.write('Other', 80);
  assert.throws(() => inspectFirmware(foreign), /другое приложение/);
}

/** @brief Exercise explicit upload, cancellation, corrupt-image rejection and authoritative acceptance. */
async function exerciseUploader({
  page,
  frame,
  context,
  service,
  artifacts,
  label,
  expectHttpError = () => () => {},
}) {
  const binary = {
    name: 'FCPLCn.bin',
    mimeType: 'application/octet-stream',
    buffer: await releaseImage(),
  };
  await frame.locator('#tab-system').click();
  await expect(frame.locator('#firmware-file')).toBeEnabled();
  assert.equal(await frame.locator('#firmware-title [data-icon="firmware"]').count(), 1);
  let begins = 0,
    finishes = 0;
  const countBegin = (request) => {
    if (request.url() === service + '/firmware/begin') begins++;
    if (request.url() === service + '/firmware/finish') finishes++;
  };
  page.on('request', countBegin);
  const response = (operation) =>
    page.waitForResponse(
      (reply) =>
        reply.url() === service + '/firmware/' + operation && reply.request().method() === 'POST',
    );
  const upload = async () => {
    page.once('dialog', (dialog) => dialog.accept());
    await frame.locator('#firmware-upload').click();
  };
  try {
    await frame.locator('#firmware-file').setInputFiles({
      name: 'wrong.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(512),
    });
    await upload();
    await expect(frame.locator('#firmware-notice')).toContainText('Нужен бинарник приложения');
    assert.equal(begins, 0, 'Invalid image rejected before beginning a transfer');

    await frame.locator('#firmware-file').setInputFiles(binary);
    let unblock, blocked;
    const gate = new Promise((resolve) => {
      unblock = resolve;
    });
    const intercepted = new Promise((resolve) => {
      blocked = resolve;
    });
    const pauseChunk = async (route) => {
      blocked();
      await gate;
      await route.continue();
    };
    await page.route(service + '/firmware/chunk', pauseChunk);
    await upload();
    await intercepted;
    await expect(frame.locator('#firmware-upload')).toBeDisabled();
    await frame.locator('#firmware-cancel').click();
    const canceled = response('abort');
    unblock();
    assert.equal((await canceled).status(), 200);
    await page.unroute(service + '/firmware/chunk', pauseChunk);
    await expect(frame.locator('#firmware-notice')).toContainText('Передача отменена');
    const canceledState = await context.request
      .get(service + '/firmware')
      .then((reply) => reply.json());
    assert.equal(canceledState.pendingReboot, false);
    assert.notEqual(canceledState.state, 'receiving');

    // Cancel is still honored while the final metadata read is in flight.
    let releaseMetadata, metadataReached;
    const metadataGate = new Promise((resolve) => {
      releaseMetadata = resolve;
    });
    const metadataRequest = new Promise((resolve) => {
      metadataReached = resolve;
    });
    const pauseMetadata = async (route) => {
      metadataReached();
      await metadataGate;
      await route.continue();
    };
    await page.route(service + '/firmware', pauseMetadata);
    await upload();
    await metadataRequest;
    await frame.locator('#firmware-cancel').click();
    const metadataCanceled = response('abort');
    releaseMetadata();
    assert.equal((await metadataCanceled).status(), 200);
    await page.unroute(service + '/firmware', pauseMetadata);
    await expect(frame.locator('#firmware-notice')).toContainText('Передача отменена');
    assert.equal(finishes, 0, 'Cancellation during final metadata fetch never activates firmware');

    // A transport-corrupted payload reaches the PLC but must never be activated.
    let corrupted = false;
    const corruptChunk = async (route) => {
      const body = route.request().postDataJSON();
      if (!corrupted) {
        corrupted = true;
        const bytes = Buffer.from(body.data, 'base64');
        bytes[400] ^= 1;
        body.data = bytes.toString('base64');
        await route.continue({ postData: JSON.stringify(body) });
      } else await route.continue();
    };
    await page.route(service + '/firmware/chunk', corruptChunk);
    const refused = response('finish');
    const stopExpecting = expectHttpError(service + '/firmware/finish', 400);
    try {
      await upload();
      const rejection = await refused;
      assert.equal(
        rejection.status(),
        400,
        'PLC refuses the complete file with a different SHA256',
      );
      assert.match((await rejection.json()).error, /SHA-256/);
      await expect(frame.locator('#firmware-notice')).toHaveClass(/error/);
    } finally {
      stopExpecting();
      await page.unroute(service + '/firmware/chunk', corruptChunk);
    }
    await frame.locator('#firmware-refresh').click();
    await expect(frame.locator('#firmware-upload')).toBeEnabled();
    const failedState = await context.request
      .get(service + '/firmware')
      .then((reply) => reply.json());
    assert.equal(failedState.pendingReboot, false);

    // The exact release application image is accepted without rewriting the saved configuration.
    const configBefore = await context.request
      .get(service + '/config')
      .then((reply) => reply.json());
    const completed = response('finish');
    let releaseActivation, activationReached;
    const activationGate = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    const activationRequest = new Promise((resolve) => {
      activationReached = resolve;
    });
    const pauseActivation = async (route) => {
      activationReached();
      await activationGate;
      await route.continue();
    };
    await page.route(service + '/firmware/finish', pauseActivation);
    await upload();
    await activationRequest;
    await expect(frame.locator('#firmware-cancel')).toBeDisabled();
    releaseActivation();
    const finishReply = await completed;
    await page.unroute(service + '/firmware/finish', pauseActivation);
    assert.equal(finishReply.status(), 200, await finishReply.text());
    const finished = await finishReply.json();
    await expect(frame.locator('#firmware-notice')).toContainText('принята');
    await expect(frame.locator('#firmware-notice')).toContainText(
      'После подключения проверьте версию',
    );
    await expect(frame.locator('#firmware-upload')).toBeDisabled();
    assert.equal(begins, 4, 'Each explicit attempt starts once; no automatic retries');
    const configAfter = await context.request
      .get(service + '/config')
      .then((reply) => reply.json());
    assert.equal(configAfter.device.name, configBefore.device.name);
    assert.equal(configAfter.revision, configBefore.revision);
    await page.setViewportSize({ width: 390, height: 950 });
    await frame.locator('.firmware-card').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifacts, `${label}-firmware-mobile.png`),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Mobile uploader has no horizontal overflow',
    );
    if (service.includes('/service')) {
      await expect
        .poll(
          async () => {
            const reply = await context.request.get(service + '/firmware');
            if (!reply.ok()) return null;
            const current = await reply.json();
            return (
              !current.pendingReboot &&
              current.imageId === finished.imageId &&
              current.runningPartition === finished.targetPartition
            );
          },
          { timeout: 10000 },
        )
        .toBe(true);
      await frame.locator('#firmware-refresh').click();
      await expect(frame.locator('#firmware-notice')).toContainText('Новая прошивка запущена');
      await expect(frame.locator('#firmware-file')).toBeEnabled();
      await expect(frame.locator('#firmware-file')).toHaveValue('');
      await frame.locator('#firmware-file').setInputFiles(binary);
      await expect(frame.locator('#firmware-upload')).toBeEnabled();
    } else {
      await expect
        .poll(async () => (await context.request.get(service + '/firmware')).status())
        .toBe(401);
      await page.goto(service.slice(0, -'/api/v1'.length));
      await page.locator('#login-username').fill('admin');
      await page.locator('#login-form button').click();
      await page.locator('#app-view').waitFor({ state: 'visible' });
      await page.locator('#tab-system').click();
      const current = await context.request
        .get(service + '/firmware')
        .then((reply) => reply.json());
      assert.equal(current.imageId, finished.imageId);
      assert.equal(current.runningPartition, finished.targetPartition);
      await expect(frame.locator('#firmware-file')).toBeEnabled();
    }

    // A bootloader rollback must replace acceptance with an error and unlock a new attempt.
    const beforeRollback = await context.request
      .get(service + '/firmware')
      .then((reply) => reply.json());
    const hubDevice = /\/api\/v1\/devices\/([^/]+)\/service$/.exec(service);
    const hubBase = hubDevice ? service.slice(0, hubDevice.index) : '';
    const priorBoot = hubDevice
      ? (
          await context.request.get(hubBase + '/api/v1/overview').then((reply) => reply.json())
        ).devices.find((device) => device.id === hubDevice[1])?.bootId
      : null;
    await frame.locator('#firmware-file').setInputFiles(binary);
    const rollbackAccepted = response('finish');
    await upload();
    const rollbackReply = await rollbackAccepted;
    assert.equal(rollbackReply.status(), 200);
    const rollbackTarget = await rollbackReply.json();
    await expect(frame.locator('#firmware-notice')).toContainText('принята');
    const observedFinishes = finishes;
    const previousBoot = async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...beforeRollback, state: 'idle', pendingReboot: false }),
      });
    await page.route(service + '/firmware', previousBoot);
    await frame.locator('#firmware-refresh').click();
    await expect(frame.locator('#firmware-notice')).toContainText('запущен другой образ');
    await expect(frame.locator('#firmware-notice')).toHaveClass(/error/);
    await expect(frame.locator('#firmware-file')).toBeEnabled();
    await expect(frame.locator('#firmware-file')).toHaveValue('');
    await page.unroute(service + '/firmware', previousBoot);
    assert.equal(finishes, observedFinishes, 'Rollback recovery never replays activation');
    if (hubDevice) {
      // The intercepted previous-boot response only tests presentation. Observe the real virtual
      // reboot and clear its server upload lease before the following offline/scenario checks.
      await expect
        .poll(
          async () => {
            const reply = await context.request.get(service + '/firmware');
            if (!reply.ok()) return false;
            const current = await reply.json();
            const overview = await context.request
              .get(hubBase + '/api/v1/overview')
              .then((response) => response.json());
            const bootId = overview.devices.find((device) => device.id === hubDevice[1])?.bootId;
            return (
              current.state === 'idle' &&
              !current.pendingReboot &&
              current.imageId === rollbackTarget.imageId &&
              current.runningPartition === rollbackTarget.targetPartition &&
              typeof bootId === 'string' &&
              bootId !== priorBoot
            );
          },
          { timeout: 10000 },
        )
        .toBe(true);
      const settled = await context.request.get(service + '/firmware');
      assert.equal(
        settled.status(),
        200,
        'The real idle firmware read releases the server upload lease',
      );
      assert.equal(finishes, observedFinishes, 'Cleanup never replays firmware activation');
    }
  } finally {
    page.off('request', countBegin);
  }
}

/** @brief Exercise the copied PLC editor through hub API routes, including its private MQTT fixture. */
async function checkHubFirmware({ page, context, base, artifacts, expectHttpError }) {
  await checkImageHelpers();
  const deviceId = 'fcplcn-demo-living';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-nav="devices"]').click();
  await page.locator(`[data-device-id="${deviceId}"]`).click();
  await page.locator(`[data-plc-configure="${deviceId}"]`).click();
  const frame = page.frameLocator('[data-plc-settings-frame]');
  await frame.locator('#app-view').waitFor({ state: 'visible' });
  await exerciseUploader({
    page,
    frame,
    context,
    service: `${base}/api/v1/devices/${deviceId}/service`,
    artifacts,
    label: 'hub-plc',
    expectHttpError,
  });
  await page.locator('[data-plc-settings-back]').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(
    'FCPLCn hub firmware browser checks passed: real application binary, invalid file and SHA rejection, cancellation, sequential progress, no retries, configuration preservation and mobile layout.',
  );
}

/** @brief Run the identical upload workflow against the standalone PLC service UI. */
async function checkLocalFirmware() {
  await checkImageHelpers();
  const { createMock } = require('../../firmware/base/tests/browser/ui_test.cjs');
  const artifacts = path.join(repository, 'hub/.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const mock = createMock();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(base);
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await exerciseUploader({
      page,
      frame: page,
      context,
      service: `${base}/api/v1`,
      artifacts,
      label: 'local-plc',
    });
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn local firmware browser checks passed: LAN-compatible SHA256, real application binary, invalid/corrupted image rejection, cancellation, progress and preserved configuration.',
    );
  } finally {
    await context.close();
    await browser.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}

module.exports = { checkHubFirmware, checkLocalFirmware, checkImageHelpers };
if (require.main === module)
  checkLocalFirmware().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
