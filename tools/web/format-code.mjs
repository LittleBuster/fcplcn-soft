#!/usr/bin/env node
/**
 * @file Единое оформление исходников веб-интерфейсов FCPLCn.
 * Использует закреплённый Prettier и общие правила из корня проекта.
 * Сборки, зависимости и данные работающих хаба и облака не обрабатываются.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const prettier = join(root, 'tools/firmware/code-style/node_modules/prettier/bin/prettier.cjs');
const projects = ['hub', 'cloud'];
const extensions = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.css', '.html', '.json']);
const excluded = new Set(['node_modules', 'dist', 'build', '.artifacts', 'test-results']);

/** Разбирает только поддерживаемые параметры, чтобы опечатка не расширяла область записи. */
function options(args) {
  let check = false;
  let selected = projects;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (argument === '--check') {
      check = true;
    } else if (argument === '--project' && projects.includes(args[index + 1])) {
      selected = [args[++index]];
    } else {
      throw new Error(
        'Использование: node tools/web/format-code.mjs [--project hub|cloud] [--check]',
      );
    }
  }

  return { check, selected };
}

/** Возвращает собственные текстовые исходники; ссылки и служебные каталоги пропускаются. */
async function sourceFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory() && !excluded.has(entry.name)) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files.sort();
}

/** Запускает установленный форматтер без загрузки пакетов и без обращения к работающим сервисам. */
async function main() {
  const { check, selected } = options(process.argv.slice(2));

  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('Для инструментов FCPLCn нужен Node.js 24.');
  }

  if (!existsSync(prettier)) {
    throw new Error('Сначала установите форматтер: npm ci --prefix tools/firmware/code-style');
  }

  const files = [];

  for (const project of selected) {
    files.push(...(await sourceFiles(join(root, project, 'web'))));
  }

  const result = spawnSync(process.execPath, [prettier, check ? '--check' : '--write', ...files], {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
