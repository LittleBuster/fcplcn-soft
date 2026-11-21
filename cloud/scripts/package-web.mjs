/** @file Reuse the shipped hub and PLC interfaces through scoped cloud APIs, without a UI fork. */
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';

const hub = new URL('../../hub/dist/', import.meta.url);
const destination = new URL('../dist/', import.meta.url);
await stat(new URL('web/index.html', hub)).catch(() => {
  throw new Error('Сначала соберите веб-панель хаба: npm --prefix hub run build:web');
});
await mkdir(destination, { recursive: true });
await cp(new URL('web/', hub), new URL('portal/', destination), { recursive: true });
let portal = await readFile(new URL('portal/index.html', destination), 'utf8');
portal = portal.replaceAll('"/assets/', '"/hub-assets/assets/').replace(
  '<head>',
  `<head>
  <meta name="fcplcn-hub-api-base" content="__FCPLCN_HUB_API_BASE__" />
  <meta name="fcplcn-cloud-portal" content="true" />
  <meta name="fcplcn-home-id" content="__FCPLCN_HOME_ID__" />
  <meta name="fcplcn-cloud-role" content="__FCPLCN_CLOUD_ROLE__" />
  <meta name="fcplcn-security-control" content="__FCPLCN_SECURITY_CONTROL__" />
  <meta name="fcplcn-csrf-token" content="__FCPLCN_CSRF_TOKEN__" />`,
);
await writeFile(new URL('portal/index.html', destination), portal);
await cp(new URL('plc/', hub), new URL('plc/', destination), { recursive: true });
const plcPath = new URL('plc/index.html', destination);
let plc = await readFile(plcPath, 'utf8');
plc = plc.replace(
  '<head>',
  '<head>\n    <meta name="fcplcn-csrf-token" content="__FCPLCN_CSRF_TOKEN__" />',
);
await writeFile(plcPath, plc);
console.log('FCPLCn: packaged shared hub portal and PLC editor for scoped cloud access');
