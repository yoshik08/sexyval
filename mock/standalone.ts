import { startMockServer } from './server';

// Usage: node dist-electron/mock/standalone.js [port]
const port = Number(process.argv[2] ?? 0) || 0;
startMockServer({ port }).then((h) => {
  console.log(`[mock] control: ${h.base}/__mock/phase?set=pregame|ingame|idle|offline|auto&elapsed=20`);
});
