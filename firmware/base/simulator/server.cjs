/**
 * @file server.cjs
 * @brief Start the loopback-only FCPLCn desktop simulator without accessing physical hardware.
 */
'use strict';

// Serve the shipped UI with the same isolated API fixture used by browser tests.
// This process never invokes ESP, Wi-Fi, Ethernet, MQTT, or system-clock tools.
const { createMock } = require('../tests/browser/ui_test.cjs');
const path = require('node:path');
const os = require('node:os');
const port = Number(process.env.FCPLCN_SIM_PORT || 4174);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FCPLCN_SIM_PORT');
const statePath =
  process.env.FCPLCN_SIM_STATE_PATH ||
  path.join(os.homedir(), 'Library/Application Support/FCPLCn/simulator-state.json');
const { server } = createMock({ interactive: true, statePath });
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`FCPLCn simulator: http://127.0.0.1:${port}`);
  console.log(
    'Login: admin; password: empty. Network/account settings remain in RAM for this process.',
  );
  console.log(`Controller settings/states persist in: ${statePath}`);
  console.log(`PID: ${process.pid}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
