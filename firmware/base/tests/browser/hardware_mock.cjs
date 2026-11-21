/**
 * @file hardware_mock.cjs
 * @brief Model virtual hardware readings and injectable I/O failures without GPIO access.
 */
'use strict';
const { framProfile } = require('./board_profiles_mock.cjs');

// RAM-only hardware demo. It never opens serial, I2C, GPIO or network devices.
/** @brief Create isolated virtual ports with explicit read/write fault injection. */
function createHardwareMock({ interactive, unixTime, localTime }) {
  const relayValues = Array(16).fill(false);
  const faults = {
    poll: '',
    relayWrite: '',
    relays: '',
    inputs: '',
    rtc: '',
    fram: '',
    getDelayMs: 0,
    relayDelayMs: 0,
  };
  const sensorGpios = [39, 40, 17, 18, 1, 2, 38, 44];
  const startedAt = Date.now();
  let inputOverride;
  const inputLocks = new Map();
  let scanStartedAt = 0;
  let scanCompleted = false;
  let getRequests = 0;
  let relayRequests = 0;
  let scanRequests = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let stateStorageSource = () => ({});
  let stateStorageSignature = '';
  let stateStorageGeneration = 0;
  const pinMap = [
    ['boot', 0, 'input'],
    ['i2c-sda', 4, 'i2c'],
    ['i2c-scl', 5, 'i2c'],
    ['i2c-ext-sda', 41, 'i2c'],
    ['i2c-ext-scl', 42, 'i2c'],
    ['rtc-sda', 4, 'i2c'],
    ['rtc-scl', 5, 'i2c'],
    ['mcp-reset', 6, 'output'],
    ['rs485-tx', 8, 'uart'],
    ['rs485-rx', 47, 'input'],
    ['rs485-dir', 48, 'output'],
    ['eth-cs', 9, 'output'],
    ['eth-sck', 10, 'spi'],
    ['eth-mosi', 11, 'spi'],
    ['eth-miso', 12, 'spi'],
    ['eth-int', 13, 'input'],
    ['eth-reset', 14, 'output'],
    ['led-net', 7, 'output'],
    ['led-status', 15, 'output'],
    ['led-alarm', 16, 'output'],
    ...sensorGpios.map((gpio, i) => [`sens-0/${i + 1}`, gpio, 'open-drain']),
    ['usb-dm', 19, 'usb'],
    ['usb-dp', 20, 'usb'],
    ['usb-vbus', 21, 'input'],
  ].map(([name, gpio, direction]) => ({ name, gpio, direction }));
  const delay = (ms) =>
    new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 3000)));
  /** @brief Report virtual FRAM allocation and saved states without accessing a device. */
  function stateStorageSnapshot() {
    const settings = stateStorageSource();
    const signature = JSON.stringify(settings);
    if (signature !== stateStorageSignature) {
      stateStorageSignature = signature;
      stateStorageGeneration++;
    }
    const available = !faults.fram || faults.fram === 'corrupt';
    const valid = available && !faults.fram;
    const payloadBytes =
      8 +
      ['sockets', 'lights', 'thermostats'].reduce(
        (total, id) => total + (Array.isArray(settings[id]?.items) ? settings[id].items.length : 0),
        0,
      );
    return {
      type: 'FRAM',
      ...framProfile,
      available,
      valid,
      simulated: true,
      lastError: valid ? 0 : available ? 0x108 : 0x107,
      generation: valid ? stateStorageGeneration : 0,
      reservedBytes: 512,
      usedBytes: 512,
      freeBytes: framProfile.capacityBytes - 512,
      payloadBytes: valid ? payloadBytes : 0,
      error: valid
        ? ''
        : available
          ? 'Сохранённые состояния FRAM повреждены'
          : faults.fram === 'missing'
            ? 'Нет связи с FRAM'
            : faults.fram,
    };
  }
  function snapshot() {
    const scanning = scanStartedAt !== 0 && Date.now() - scanStartedAt < 200;
    if (scanStartedAt && !scanning) scanCompleted = true;
    const updatedAtMs = Date.now() - startedAt;
    const inputs =
      inputOverride ||
      Array.from({ length: 16 }, (_, i) =>
        Boolean((i + (interactive ? Math.floor(updatedAtMs / 5000) : 0)) % 2),
      );
    for (const [index, value] of inputLocks) inputs[index] = value;
    const channels = (values, relay) =>
      values.map((value, i) => ({
        id: `${relay ? 'rly' : 'in'}-0/${i + 1}`,
        value: faults[relay ? 'relays' : 'inputs'] ? null : value,
        level: faults[relay ? 'relays' : 'inputs'] ? null : value,
        active: faults[relay ? 'relays' : 'inputs'] ? null : relay ? value : !value,
        activeHigh: relay,
        valid: !faults[relay ? 'relays' : 'inputs'],
        expander: i < 8 ? 'U5' : 'U6',
        address: i < 8 ? 0x20 : 0x21,
        pin: relay ? (i % 8 === 7 ? 15 : (i % 8) + 1) : i % 8 === 7 ? 0 : (i % 8) + 8,
        error: faults[relay ? 'relays' : 'inputs'] || null,
        updatedAtMs,
      }));
    const rtcValid = !faults.rtc;
    return {
      initialized: true,
      error: null,
      simulated: true,
      relays: channels(relayValues, true),
      inputs: channels(inputs, false),
      i2c: [
        {
          id: 'io-expanders',
          sdaGpio: 4,
          sclGpio: 5,
          ready: true,
          scanning,
          addresses: scanCompleted
            ? [0x20, 0x21, ...(!faults.fram || faults.fram === 'corrupt' ? [0x50] : []), 0x68]
            : [],
          error: null,
          updatedAtMs: scanCompleted ? updatedAtMs : null,
        },
        {
          id: 'isolated-sensors',
          sdaGpio: 41,
          sclGpio: 42,
          ready: true,
          scanning,
          addresses: scanCompleted ? [0x44] : [],
          error: null,
          updatedAtMs: scanCompleted ? updatedAtMs : null,
        },
      ],
      leds: [
        { id: 'led-net', gpio: 7, value: true, valid: true },
        { id: 'led-status', gpio: 15, value: true, valid: true },
        { id: 'led-alarm', gpio: 16, value: false, valid: true },
      ],
      sensors: sensorGpios.map((gpio, i) => ({
        id: `sens-0/${i + 1}`,
        gpio,
        ready: true,
        mode: 'open-drain-released',
        error: null,
      })),
      pinMap,
      rtc: {
        model: 'DS3231MZ+',
        busId: 'io-expanders',
        address: 0x68,
        present: true,
        valid: rtcValid,
        unixTime: rtcValid ? unixTime() : null,
        localTime: rtcValid ? localTime(unixTime()) : '',
        error: faults.rtc || null,
      },
      stateStorage: stateStorageSnapshot(),
    };
  }
  async function request(action) {
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    try {
      return await action();
    } finally {
      activeRequests--;
    }
  }
  return {
    snapshot,
    stateStorageSnapshot,
    /** @brief Read saved controller settings lazily after all virtual services are initialized. */
    setStateStorageSource(read) {
      if (typeof read !== 'function') throw new TypeError('Expected a state storage source');
      stateStorageSource = read;
    },
    // Internal mock adapter for autonomous controllers, never an HTTP route.
    driveRelay(id, value) {
      const index = relayValues.findIndex((_, i) => id === `rly-0/${i + 1}`);
      if (index < 0 || typeof value !== 'boolean') return 'Неизвестное реле';
      if (faults.relayWrite || faults.relays) return faults.relayWrite || faults.relays;
      relayValues[index] = value;
      return '';
    },
    lockInput(id) {
      const index = Array.from({ length: 16 }, (_, i) => `in-0/${i + 1}`).indexOf(id);
      if (index < 0) throw new Error('Unknown simulated input');
      if (!inputLocks.has(index))
        inputLocks.set(index, inputOverride ? inputOverride[index] : true);
    },
    unlockInput(id) {
      inputLocks.delete(Number(id.split('/')[1]) - 1);
    },
    setInputLevel(id, value) {
      const index = Number(id.split('/')[1]) - 1;
      if (!inputLocks.has(index) || typeof value !== 'boolean')
        throw new Error('Input is not assigned to a simulated button');
      inputLocks.set(index, value);
    },
    setFaults(value) {
      Object.assign(faults, value);
    },
    setInputs(values) {
      if (
        !Array.isArray(values) ||
        values.length !== 16 ||
        !values.every((value) => typeof value === 'boolean')
      )
        throw new Error('Expected sixteen raw boolean inputs');
      inputOverride = [...values];
      for (const index of inputLocks.keys()) inputLocks.set(index, values[index]);
    },
    async get() {
      return request(async () => {
        getRequests++;
        const captured = snapshot(); // Delayed GET makes stale-read races testable.
        await delay(faults.getDelayMs);
        return faults.poll
          ? { status: 503, data: { error: faults.poll } }
          : { status: 200, data: captured };
      });
    },
    async relay(data) {
      return request(async () => {
        relayRequests++;
        const index =
          typeof data.id === 'string'
            ? relayValues.findIndex((_, i) => data.id === `rly-0/${i + 1}`)
            : -1;
        if (typeof data.id !== 'string' || typeof data.value !== 'boolean')
          return { status: 400, data: { error: 'Некорректная команда реле' } };
        if (index < 0) return { status: 404, data: { error: 'Неизвестное реле' } };
        await delay(faults.relayDelayMs);
        if (faults.relayWrite) return { status: 503, data: { error: faults.relayWrite } };
        relayValues[index] = data.value;
        return { status: 200, data: { ok: true, hardware: snapshot() } };
      });
    },
    scan() {
      scanRequests++;
      if (!scanStartedAt || Date.now() - scanStartedAt >= 200) {
        scanStartedAt = Date.now();
        scanCompleted = false;
      }
      return { ok: true, queued: true };
    },
    reboot() {
      relayValues.fill(false);
      scanStartedAt = 0;
      scanCompleted = false;
    },
    get getRequests() {
      return getRequests;
    },
    get relayRequests() {
      return relayRequests;
    },
    get scanRequests() {
      return scanRequests;
    },
    get maxActiveRequests() {
      return maxActiveRequests;
    },
  };
}
module.exports = { createHardwareMock };
