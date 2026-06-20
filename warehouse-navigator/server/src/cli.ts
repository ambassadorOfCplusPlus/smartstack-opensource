// Запуск LAN-сервера навигатора. Опционально принимает путь к файлу-снимку склада
// (.whnav.json) — тогда сервер сразу отдаёт его данные. Печатает адреса в локальной
// сети, которые надо ввести в мобильном приложении.
//
//   node src/cli.ts [snapshot.whnav.json]      (Node 24: TS выполняется нативно)
//   PORT=9000 node src/cli.ts demo.whnav.json

import { readFileSync } from 'node:fs';
import os from 'node:os';
import {
  InMemoryWarehouseStore,
  parseSnapshot,
} from '@smartstack/warehouse-navigator-core';
import { createNavServer } from './server.ts';

const port = Number(process.env.PORT ?? 8088);
const file = process.argv[2];

const store = new InMemoryWarehouseStore();
if (file) {
  store.loadSnapshot(parseSnapshot(readFileSync(file, 'utf8')));
  console.log(`Загружен снимок склада: ${file}`);
} else {
  console.log('Снимок не задан — пусто. Загрузите через POST /api/snapshot или укажите файл.');
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

createNavServer(store).listen(port, () => {
  console.log(`\nНавигатор-сервер слушает порт ${port}.`);
  console.log('В мобильном приложении укажите один из адресов:');
  for (const ip of lanAddresses()) console.log(`  http://${ip}:${port}`);
  console.log(`  http://localhost:${port}  (только этот ПК)\n`);
});
