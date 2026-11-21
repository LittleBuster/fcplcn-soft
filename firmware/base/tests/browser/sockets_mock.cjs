/**
 * @file sockets_mock.cjs
 * @brief Keep the socket-only fixture entry point backed by the shared controller model.
 */
'use strict';
// Compatibility for tools that imported the original single-module fixture.
const { createControllersMock } = require('./controllers_mock.cjs');
module.exports = { createSocketsMock: (options) => createControllersMock(options).modules.sockets };
