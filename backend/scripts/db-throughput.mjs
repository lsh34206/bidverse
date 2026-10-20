// MongoDB 초당 처리량(ops/s) 측정. 무료 티어(M0)는 초당 약 100 ops 로 제한되어 부하 테스트 수치를 가린다.
//   node scripts/db-throughput.mjs [동시성=50] [총 요청수=600]
import mongoose from 'mongoose';
try { process.loadEnvFile('.env'); } catch {}
const conc = Number(process.argv[2]) || 50;
const total = Number(process.argv[3]) || 600;
const dbName = `bidverse_check_${Date.now()}`;
await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10000, minPoolSize: conc, maxPoolSize: conc });
const col = mongoose.connection.collection('probe');
await col.insertOne({ k: 1 });
await Promise.all(Array.from({ length: conc }, () => col.findOne({ k: 1 }))); // 커넥션 풀 워밍업
let done = 0;
const t0 = performance.now();
const lat = [];
await Promise.all(Array.from({ length: conc }, async () => {
  while (done < total) {
    done++;
    const t = performance.now();
    await col.findOne({ k: 1 });
    lat.push(performance.now() - t);
  }
}));
const sec = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
console.log(`동시성 ${conc}, 단순 findOne ${total}건: ${sec.toFixed(1)}초 → ${(total / sec).toFixed(0)} ops/s, 지연 p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)}ms p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(0)}ms`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
