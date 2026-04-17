import { defineConfig } from 'drizzle-kit';

// Migrations use the admin (superuser) connection.
// The application uses a separate non-superuser role with RLS enforced.
const adminUrl = process.env.DOLLHOUSE_DATABASE_ADMIN_URL
  ?? process.env.DOLLHOUSE_DATABASE_URL
  ?? 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp';

export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: adminUrl,
  },
});
