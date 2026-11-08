import postgres from 'postgres';
const sql = postgres(process.argv[2], { ssl: process.argv[3], connect_timeout: 5 });
try {
  await sql`select 1`;
} catch {
  // The fixture server closes after receiving the actual startup packet.
} finally {
  await sql.end({ timeout: 1 });
}
