// 관리자 권한 부여/회수 CLI. 서버에서 직접 실행한다 (API로는 최초 관리자를 만들 수 없게 의도한 것).
//
//   npm run admin:grant  -- user@example.com        # 관리자로 지정
//   npm run admin:revoke -- user@example.com        # 일반 사용자로 되돌림
//
// backend/.env 의 MONGODB_URI 를 사용한다.
import mongoose from 'mongoose';

const [mode, email] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(mode) || !email) {
  console.error('사용법: node scripts/grant-admin.mjs <grant|revoke> <email>');
  process.exit(1);
}

try {
  process.loadEnvFile('.env');
} catch {
  // .env 가 없으면 이미 주입된 환경변수를 쓴다.
}
const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/bidverse';

await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
try {
  const role = mode === 'grant' ? 'admin' : 'buyer';
  const res = await mongoose.connection
    .collection('users')
    .updateOne({ email: email.toLowerCase() }, { $set: { role } });
  if (res.matchedCount === 0) {
    console.error(`해당 이메일의 사용자가 없음: ${email}`);
    process.exitCode = 1;
  } else {
    console.log(`${email} -> ${role}`);
  }
} finally {
  await mongoose.disconnect();
}
