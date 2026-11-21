/**
 * @file meteo_mock.cjs
 * @brief Provide deterministic virtual DHT22 and DS18B20 discovery and freshness behavior.
 */
'use strict';

function crc8(bytes) {
  let crc = 0;
  for (let byte of bytes)
    for (let bit = 0; bit < 8; bit++) {
      const mix = (crc ^ byte) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      byte >>= 1;
    }
  return crc;
}
function validRom(value) {
  return (
    typeof value === 'string' &&
    /^28[0-9a-f]{14}$/i.test(value) &&
    crc8(Buffer.from(value, 'hex')) === 0
  );
}
function demoRoms(portId) {
  const index = Number(portId.split('/')[1]);
  return [1, 2].map((serial) => {
    const bytes = Buffer.from([0x28, 0xff, index, serial, 0x12, 0x34, 0x56]);
    return Buffer.concat([bytes, Buffer.from([crc8(bytes)])]).toString('hex');
  });
}
/** @brief Create queued virtual scans and timestamped samples, without emulating physical timing. */
function createMeteoMock({ sensors, dhtClaimed }) {
  const scans = new Map(),
    faults = new Map();
  const sources = new Map(),
    overrides = new Map();
  let generation = 0;
  const signature = (item) => `${item.portId}/${item.sensorType}/${item.address}`;
  function devices(portId) {
    const scan = scans.get(portId);
    if (!scan?.complete || scan.error) return [];
    return demoRoms(portId).map((address, index) => ({
      address,
      temperatureC: faults.has(portId) ? null : 20.5 + Number(portId.split('/')[1]) + index / 2,
      available: !faults.has(portId),
      error: faults.get(portId) || null,
      ageMs: faults.has(portId) ? null : (Date.now() - scan.updatedAt) % 5000,
    }));
  }
  function scan(data) {
    if (
      !sensors.includes(data?.portId) ||
      (data.refresh !== undefined && typeof data.refresh !== 'boolean')
    )
      return { status: 400, data: { error: 'Некорректный сенсорный порт' } };
    if (dhtClaimed(data.portId, data))
      return { status: 409, data: { error: 'Порт занят DHT22 или контекст сканирования устарел' } };
    let job = scans.get(data.portId);
    if (!job || (data.refresh && !job.busy)) {
      job = { busy: true, complete: false, error: null, updatedAt: 0 };
      scans.set(data.portId, job);
      job.timer = setTimeout(() => {
        job.busy = false;
        job.complete = true;
        job.error = faults.get(data.portId) || null;
        job.updatedAt = Date.now();
      }, 250).unref();
    }
    return {
      status: 200,
      data: {
        ok: true,
        portId: data.portId,
        busy: job.busy,
        complete: job.complete,
        error: job.error,
        devices: devices(data.portId),
      },
    };
  }
  function reading(item, enabled) {
    const error = !enabled ? 'Модуль выключен' : faults.get(item.portId) || null;
    if (item.sensorType === 'dht22')
      return {
        available: !error,
        error,
        temperatureC: error ? null : 22 + Number(item.portId.split('/')[1]) / 10,
        humidityPct: error ? null : 45.5,
        ageMs: error ? null : Date.now() % 2000,
        devices: [],
      };
    const found = devices(item.portId),
      selected = found.find((device) => device.address === item.address);
    const issue =
      error ||
      (!selected
        ? scans.get(item.portId)?.busy
          ? 'Поиск датчиков'
          : 'Датчик не найден'
        : selected.error);
    return {
      available: !issue,
      error: issue,
      temperatureC: issue ? null : selected.temperatureC,
      humidityPct: null,
      ageMs: issue ? null : selected.ageMs,
      devices: found,
    };
  }
  function controlledReading(item, enabled) {
    const result = reading(item, enabled),
      override = overrides.get(signature(item));
    if (override && result.available) {
      result.temperatureC = override.temperatureC;
      if (override.ageMs !== undefined) result.ageMs = override.ageMs;
    }
    return result;
  }
  const readFailures = new Set();
  return {
    scan,
    setReadFailure(id, failed) {
      if (failed) readFailures.add(id);
      else readFailures.delete(id);
    },
    configure(module) {
      for (const id of sources.keys())
        if (!module.items.some((item) => item.id === id)) sources.delete(id);
      for (const item of module.items) {
        if (sources.get(item.id)?.signature !== signature(item))
          sources.set(item.id, {
            signature: signature(item),
            generation: ++generation,
            sequence: 0,
            sampledAt: Date.now(),
          });
        if (module.enabled && item.sensorType === 'onewire') scan({ portId: item.portId });
      }
    },
    reading: controlledReading,
    observation(item, enabled) {
      const result = controlledReading(item, enabled),
        source = sources.get(item.id);
      if (source && result.available && Date.now() - source.sampledAt >= 1000) {
        source.sampledAt = Date.now();
        source.sequence++;
      }
      return {
        ...result,
        readFailed: readFailures.has(item.id),
        generation: source?.generation || 0,
        sequence: source?.sequence || 0,
        postChangeSample: Boolean(source?.sequence),
      };
    },
    setTemperature(item, temperatureC, { ageMs } = {}) {
      if (
        !Number.isFinite(temperatureC) ||
        temperatureC < -55 ||
        temperatureC > 125 ||
        (ageMs !== undefined && (!Number.isFinite(ageMs) || ageMs < 0))
      )
        throw new Error('Некорректная температура симулятора');
      overrides.set(signature(item), { temperatureC, ageMs });
      const source = sources.get(item.id);
      if (source) {
        source.sequence++;
        source.sampledAt = Date.now();
      }
    },
    setFault(portId, error) {
      if (error) faults.set(portId, error);
      else faults.delete(portId);
    },
    reset() {
      for (const scan of scans.values()) clearTimeout(scan.timer);
      scans.clear();
      sources.clear();
    },
  };
}
module.exports = { createMeteoMock, validRom, demoRoms };
