"""Embed version-bound service UI assets with deterministic gzip representations."""
import gzip
import hashlib
import html
import json
from pathlib import Path
import re
import sys


def asset_version(web, product_path, filenames):
    """Bind the complete module graph and product identity to one release token."""
    digest = hashlib.sha256(product_path.read_bytes())
    for filename in filenames:
        digest.update(filename.encode('utf-8') + b'\0')
        digest.update((web / filename).read_bytes() + b'\0')
    return digest.hexdigest()[:24]


def prepared_source(web, filename, product, version):
    """Version every local module edge so a browser cannot mix firmware releases."""
    source = (web / filename).read_text()
    source = source.replace('__PRODUCT_NAME__', html.escape(product['name']))
    source = source.replace('__PRODUCT_FULL_NAME__', html.escape(product['fullName']))
    if filename.endswith('.js'):
        source = re.sub(r'''(from\s*['"])(\.[^'"]+\.js)(['"])''',
                        lambda match: match[1] + match[2] + '?v=' + version + match[3], source)
    if filename == 'index.html':
        source = source.replace('href="/style.css"', f'href="/style.css?v={version}"')
        source = source.replace('src="/app.js"', f'src="/app.js?v={version}"')
    return source.encode('utf-8')


def byte_array(chunks, symbol, data):
    """Write a compact constant byte array without runtime decompression or allocation."""
    chunks.append(f'inline constexpr std::uint8_t {symbol}[] = {{')
    chunks.extend(','.join(f'0x{byte:02x}' for byte in data[index:index+24]) + ','
                  for index in range(0, len(data), 24))
    chunks.append('};')


def main():
    web, product_path, output = map(Path, sys.argv[1:])
    product = json.loads(product_path.read_text())
    filenames = json.loads((web / 'assets.json').read_text())
    if len(set(filenames)) != len(filenames):
        raise ValueError('Duplicate embedded asset path')
    for filename in filenames:
        if Path(filename).is_absolute() or '..' in Path(filename).parts:
            raise ValueError('Invalid embedded asset path')
    version = asset_version(web, product_path, filenames)
    chunks = ['#pragma once', '#include <cstddef>', '#include <cstdint>',
              'struct WebAsset {',
              '    const char* path;', '    const char* mime;',
              '    const std::uint8_t* identity;', '    std::size_t identitySize;',
              '    const std::uint8_t* gzip;', '    std::size_t gzipSize;',
              '    const char* identityEtag;', '    const char* gzipEtag;',
              '    bool html;', '};',
              f'inline constexpr char web_asset_version[] = "{version}";']
    entries = []
    for index, filename in enumerate(filenames):
        data = prepared_source(web, filename, product, version)
        compressed = bytearray(gzip.compress(data, compresslevel=9, mtime=0))
        compressed[9] = 255  # OS-independent gzip header; timestamp is already zero.
        symbol = f'web_asset_{index}'
        byte_array(chunks, symbol + '_identity', data)
        byte_array(chunks, symbol + '_gzip', compressed)
        mime = 'application/javascript; charset=utf-8' if filename.endswith('.js') else (
            'text/css; charset=utf-8' if filename.endswith('.css') else 'text/html; charset=utf-8')
        identity_etag = hashlib.sha256(data).hexdigest()
        gzip_etag = hashlib.sha256(compressed).hexdigest()
        entries.append(f'    {{"/{filename}", "{mime}", {symbol}_identity, {len(data)}, '
                       f'{symbol}_gzip, {len(compressed)}, "\\"{identity_etag}\\"", '
                       f'"\\"{gzip_etag}\\"", {str(filename == "index.html").lower()}}},')
    chunks.extend(['inline constexpr WebAsset web_assets[] = {', *entries, '};'])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(chunks) + '\n')


if __name__ == '__main__':
    main()
