// MongoDB 연결 점검. 접속 문자열(계정/비밀번호 포함)은 출력하지 않는다.
//
//   npm run db:check
//
// backend/.env 의 MONGODB_URI 로 접속해서 서버 버전, 레플리카셋 여부, 쓰기 권한을 확인한다.
// 점검용 임시 데이터베이스를 만들었다가 지운다 (기존 데이터는 건드리지 않는다).
import mongoose from 'mongoose';

try {
  process.loadEnvFile('.env');
} catch {
  // .env 가 없으면 이미 주입된 환경변수를 쓴다.
}
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI 가 설정되어 있지 않음 (backend/.env)');
  process.exit(1);
}

const scheme = uri.split('://')[0];
console.log(`접속 방식: ${scheme}`);

const dbName = `bidverse_check_${Date.now()}`;
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, dbName });
  const admin = mongoose.connection.db.admin();
  const info = await admin.serverInfo();
  console.log(`연결 OK, 서버 버전 ${info.version}`);

  const hello = await mongoose.connection.db.command({ hello: 1 });
  console.log(`레플리카셋: ${hello.setName ? `예 (${hello.setName})` : '아니오 (단일 서버)'}`);

  const col = mongoose.connection.collection('probe');
  await col.insertOne({ ok: true });
  console.log('쓰기 권한 OK (임시 DB)');
  await mongoose.connection.dropDatabase();
  console.log('임시 DB 정리 완료');
} catch (err) {
  console.error(`실패: ${err.name}: ${err.message.replace(/\/\/[^@\s]*@/g, '//***@')}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
