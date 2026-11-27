/**
 * @file app.js
 * @brief Compose explicitly connected service UI modules and start the application.
 */
import { createCoreUI } from './modules/core.js';
import { createHardwareUI } from './modules/hardware.js';
import { createControllersUI } from './modules/controllers.js';
import { createMeteoUI } from './modules/meteo.js';
import { createSecurityUI } from './modules/security.js';
import { createIrrigationUI } from './modules/irrigation.js';
import { createTanksUI } from './modules/tanks.js';
import { createThermostatsUI } from './modules/thermostats.js';
import { createSettingsUI } from './modules/settings.js';
import { createBackupUI } from './modules/backup.js';
import { createFirmwareUI } from './modules/firmware.js';
import { createBootstrapUI } from './modules/bootstrap.js';

const context = {};
Object.assign(context, createCoreUI(context));
Object.assign(context, createHardwareUI(context));
Object.assign(context, createControllersUI(context));
Object.assign(context, createMeteoUI(context));
Object.assign(context, createThermostatsUI(context));
Object.assign(context, createSecurityUI(context));
Object.assign(context, createTanksUI(context));
Object.assign(context, createIrrigationUI(context));
Object.assign(context, createSettingsUI(context));
Object.assign(context, createBackupUI(context));
Object.assign(context, createFirmwareUI(context));
Object.assign(context, createBootstrapUI(context));
context.start();
