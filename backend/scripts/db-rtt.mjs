// MongoDB 왕복 지연(RTT) 측정. 부하 테스트 지연이 서버 때문인지 DB까지의 거리 때문인지 가릴 때 쓴다.
//   node scripts/db-rtt.mjs
import mongoose from 'mongoose';
try { process.loadEnvFile('.env'); } catch {}
await mongoose.connect(process.env.MONGODB_URI, { dbName: `bidverse_check_${Date.now()}`, serverSelectionTimeoutMS: 10000 });
const admin = mongoose.connection.db.admin();
await admin.ping(); // 연결 워밍업
const times = [];
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  await admin.ping();
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(`ping 20회  최소 ${times[0].toFixed(0)}ms  중앙값 ${times[10].toFixed(0)}ms  최대 ${times[19].toFixed(0)}ms`);
await mongoose.disconnect();
