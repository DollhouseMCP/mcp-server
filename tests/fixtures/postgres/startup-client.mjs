import postgres from 'postgres';
const sql = postgres(process.argv[2], { ssl: process.argv[3], connect_timeout: 5 });
try {
  await sql`select 1`;
} catch (error) {
  // The fixture server closes after receiving the actual startup packet.
  process.stderr.write(`fixture client: ${error.code || 'connection failed'}\n`);
} finally {
  await sql.end({ timeout: 1 });
}
