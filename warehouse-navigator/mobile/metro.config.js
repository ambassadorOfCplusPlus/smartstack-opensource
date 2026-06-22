// Metro видит ядро навигатора как симлинк (`file:../core`), лежащий ВНЕ корня
// проекта. По умолчанию Metro не выходит за пределы projectRoot и не разворачивает
// симлинки → при бандлинге релиза `@smartstack/warehouse-navigator-core` не
// резолвился. Добавляем папку ядра в watchFolders и явное соответствие имени пакета
// его каталогу (main = dist/index.js — ядро нужно собрать: `npm run build` в core).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, '..', 'core');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [coreRoot];
// И app/node_modules, и core/node_modules — чтобы транзитивные зависимости ядра (если
// появятся; сейчас ядро zero-deps) тоже резолвились при бандлинге.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(coreRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@smartstack/warehouse-navigator-core': coreRoot,
};

module.exports = config;
