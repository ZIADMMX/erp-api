import http from 'http';
import { app } from './app';
import { env } from './config';
import { prisma } from './db';
import { initRealtime } from './realtime';

const server = http.createServer(app);
initRealtime(server);

server.listen(env.PORT, '0.0.0.0', () => {
  console.log(`✅ ERP API شغال على المنفذ ${env.PORT} (${env.NODE_ENV})`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
