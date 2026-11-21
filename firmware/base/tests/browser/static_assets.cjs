/**
 * @file static_assets.cjs
 * @brief Serve the real module graph with firmware-equivalent version, gzip and cache rules.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** @brief Parse a coding preference, respecting explicit q=0 over wildcard fallback. */
function encodingQuality(header, coding) {
  const values = new Map();
  for (const entry of String(header || '')
    .toLowerCase()
    .split(',')) {
    const [name, ...parameters] = entry.trim().split(';');
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q\s*=\s*(.*)$/);
      if (match) {
        const raw = match[1];
        quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
      }
    }
    values.set(name, quality);
  }
  return values.has(coding)
    ? values.get(coding)
    : coding === 'identity'
      ? values.get('*') === 0
        ? 0
        : 1
      : values.get('*') || 0;
}

/** @brief Match weak or strong GET validators against the selected encoded representation. */
function matchesEtag(header, selected) {
  let quoted = false,
    begin = 0;
  const value = String(header || '');
  for (let index = 0; index <= value.length; index++) {
    if (value[index] === '"') quoted = !quoted;
    if (index === value.length || (value[index] === ',' && !quoted)) {
      const tag = value.slice(begin, index).trim();
      if (tag === '*' || tag.replace(/^W\//, '') === selected) return true;
      begin = index + 1;
    }
  }
  return false;
}

/** @brief Load and version the manifest once for an isolated running simulator. */
function createStaticAssets({
  directory,
  productPath,
  transform = (_file, data) => data,
  extras = {},
}) {
  const filenames = JSON.parse(fs.readFileSync(path.join(directory, 'assets.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(productPath));
  for (const filename of filenames) {
    digest.update(filename + '\0');
    digest.update(fs.readFileSync(path.join(directory, filename)));
    digest.update('\0');
  }
  const version = digest.digest('hex').slice(0, 24);
  const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
  const escape = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#x27;');
  const assets = new Map();
  for (const filename of [...filenames, ...Object.keys(extras)]) {
    let source = extras[filename] ?? fs.readFileSync(path.join(directory, filename), 'utf8');
    source = source
      .replaceAll('__PRODUCT_NAME__', escape(product.name))
      .replaceAll('__PRODUCT_FULL_NAME__', escape(product.fullName));
    if (filename.endsWith('.js'))
      source = source.replace(
        /(from\s*['"])(\.[^'"]+\.js)(['"])/g,
        (_all, prefix, specifier, suffix) => `${prefix}${specifier}?v=${version}${suffix}`,
      );
    if (filename === 'index.html')
      source = source
        .replace('href="/style.css"', `href="/style.css?v=${version}"`)
        .replace('src="/app.js"', `src="/app.js?v=${version}"`);
    const identity = Buffer.from(transform(filename, source));
    const gzip = zlib.gzipSync(identity, { level: 9, mtime: 0 });
    gzip[9] = 255;
    const etag = (value) => `"${crypto.createHash('sha256').update(value).digest('hex')}"`;
    assets.set('/' + filename, {
      identity,
      gzip,
      identityEtag: etag(identity),
      gzipEtag: etag(gzip),
      html: filename === 'index.html',
      mime: filename.endsWith('.js')
        ? 'application/javascript; charset=utf-8'
        : filename.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/html; charset=utf-8',
    });
  }
  return {
    version,
    /** @brief Serve only manifest paths and reject module URLs from another firmware release. */
    serve(request, response) {
      const url = new URL(request.url, 'http://fcplcn.local');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const asset = assets.get(pathname);
      const requested = url.searchParams.get('v');
      if (!asset || url.searchParams.getAll('v').some((value) => value !== version)) {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const gzipQuality = encodingQuality(request.headers['accept-encoding'], 'gzip');
      const identityQuality = encodingQuality(request.headers['accept-encoding'], 'identity');
      if (gzipQuality <= 0 && identityQuality <= 0) {
        response.writeHead(406, { 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' });
        response.end();
        return;
      }
      const compressed = gzipQuality > 0 && gzipQuality >= identityQuality;
      const data = compressed ? asset.gzip : asset.identity;
      const selectedEtag = compressed ? asset.gzipEtag : asset.identityEtag;
      const headers = {
        'Content-Type': asset.mime,
        ETag: selectedEtag,
        Vary: 'Accept-Encoding',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
        'Cache-Control':
          !asset.html && requested === version ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      if (compressed) headers['Content-Encoding'] = 'gzip';
      if (matchesEtag(request.headers['if-none-match'], selectedEtag)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
    },
  };
}
module.exports = { createStaticAssets, encodingQuality, matchesEtag };
