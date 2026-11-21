/** @file Package the canonical PLC service panel for same-origin MQTT management through the hub. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = new URL('../../firmware/base/web/', import.meta.url);
const destination = new URL('../dist/plc/', import.meta.url);
const product = JSON.parse(
  await readFile(new URL('../../config/product.json', import.meta.url), 'utf8'),
);
const assets = JSON.parse(await readFile(new URL('assets.json', source), 'utf8'));
const escape = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
await mkdir(destination, { recursive: true });
for (const asset of assets) {
  if (
    typeof asset !== 'string' ||
    !/^[a-zA-Z0-9_./-]+$/.test(asset) ||
    asset.includes('..') ||
    asset.startsWith('/')
  )
    throw new Error('Unsafe PLC asset manifest entry');
  let text = await readFile(new URL(asset, source), 'utf8');
  if (asset === 'index.html') {
    text = text
      .replaceAll('__PRODUCT_NAME__', escape(product.name))
      .replaceAll('__PRODUCT_FULL_NAME__', escape(product.fullName));
    text = text.replace(
      '<head>',
      '<head>\n    <meta name="fcplcn-api-base" content="__FCPLCN_API_BASE__" />\n    <meta name="fcplcn-hub-embedded" content="true" />',
    );
    text = text
      .replace('href="/style.css"', 'href="/plc-assets/style.css"')
      .replace('src="/app.js"', 'src="/plc-assets/app.js"');
    text = text.replace(
      '</head>',
      '    <link rel="stylesheet" href="/plc-assets/hub-embedded.css" />\n  </head>',
    );
  }
  if (asset === 'app.js') text = `import './hub-embedded.js';\n${text}`;
  const target = new URL(asset, destination);
  await mkdir(new URL('./', target), { recursive: true });
  await writeFile(target, text);
}

// This adapter belongs only to the hub build; standalone PLC authentication stays unchanged.
await writeFile(
  new URL('hub-embedded.js', destination),
  `/** @file Hub-only service panel presentation and connection retry. */
const marker = document.querySelector('meta[name="fcplcn-hub-embedded"]');
if (marker?.content === 'true') {
  document.documentElement.dataset.fcplcnHubEmbedded = 'true';
  document.getElementById('logout').hidden = true;
  const login = document.getElementById('login-view');
  login.querySelector('h2').textContent = 'Подключение к PLC';
  login.querySelector('.muted').textContent = 'Настройка через локальный хаб. Отдельный вход в PLC не требуется.';
  const form = document.getElementById('login-form');
  form.querySelector('button').textContent = 'Повторить подключение';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.reload();
  }, true);
}
`,
);
await writeFile(
  new URL('hub-embedded.css', destination),
  `/* Only the hub-hosted copy hides independent PLC authentication. */
html[data-fcplcn-hub-embedded='true'] #logout,
html[data-fcplcn-hub-embedded='true'] #login-form label,
html[data-fcplcn-hub-embedded='true'] #login-form input { display: none !important; }
html[data-fcplcn-hub-embedded='true'] .shell { max-width: 1300px; margin: 0 auto; padding: 20px; }
html[data-fcplcn-hub-embedded='true'] .header { margin-bottom: 20px; }
@media (max-width: 600px) { html[data-fcplcn-hub-embedded='true'] .shell { padding: 14px; } }
`,
);
console.log(`FCPLCn: packaged ${assets.length} PLC service assets and embedded adapter`);
