// Точка входа: собрать приложение и слушать порт.
import { buildApp } from './app';

async function main(): Promise<void> {
  const { app } = await buildApp();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
