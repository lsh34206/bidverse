// E2E/부하 테스트가 만든 임시 DB(bidverse_e2e_*, bidverse_load_*, bidverse_check_*)를 정리한다.
// 테스트가 비정상 종료돼서 남은 것만 지우며, 그 외 이름의 DB는 절대 건드리지 않는다.
//
//   npm run db:clean-temp
import mongoose from 'mongoose';

const TEMP = /^bidverse_(e2e|load|check)_/;

try {
  process.loadEnvFile('.env');
} catch {
  // .env 가 없으면 이미 주입된 환경변수를 쓴다.
}
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI 가 설정되어 있지 않음 (backend/.env)');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, dbName: 'admin' });
try {
  const client = mongoose.connection.getClient();
  const { databases } = await client.db('admin').admin().listDatabases();
  const temps = databases.map((d) => d.name).filter((n) => TEMP.test(n));
  for (const name of temps) {
    await client.db(name).dropDatabase();
    console.log(`삭제: ${name}`);
  }
  console.log(temps.length ? `임시 DB ${temps.length}개 정리 완료` : '정리할 임시 DB 없음');
} catch (err) {
  console.error(`실패: ${err.message.replace(/\/\/[^@\s]*@/g, '//***@')}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
