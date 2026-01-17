# Migration Plan: Neon to Heroku Postgres

## Overview
Migrate the database from Neon PostgreSQL to Heroku Postgres Essential 0 ($5/mo, 1GB storage).

## Current Setup Analysis

### Database Connections
Two different database clients are used:

1. **Root project** (`package.json`): Uses `pg` (node-postgres) directly
   - Standard PostgreSQL driver, no changes needed

2. **stellar-events-stream**: Uses Neon-specific drivers
   - `@neondatabase/serverless` - Neon's HTTP driver
   - `drizzle-orm/neon-http` - Drizzle adapter for Neon
   - Files affected:
     - `stellar-events-stream/src/db/index.ts`
     - `stellar-events-stream/src/db/migrate.ts`

### Tables to Migrate
- `pool_snapshots`
- `user_positions`
- `raw_events`
- `blend_events`
- `blend_events_parsed`
- `blend_res_data`
- `blend_actions`
- `parsed_events`
- Multiple views (`v_derived_rates`, `v_user_positions`, etc.)

---

## Migration Steps

### Phase 1: Prepare Heroku

1. **Create Heroku app** (if not exists)
   ```bash
   heroku create your-app-name
   ```

2. **Add Heroku Postgres Essential 0**
   ```bash
   heroku addons:create heroku-postgresql:essential-0 -a your-app-name
   ```

3. **Get Heroku DATABASE_URL**
   ```bash
   heroku config:get DATABASE_URL -a your-app-name
   ```

---

### Phase 2: Export from Neon

1. **Get current Neon connection string** from your `.env` file

2. **Export full database using pg_dump**
   ```bash
   pg_dump "postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require" \
     --no-owner \
     --no-acl \
     --format=custom \
     -f neon_backup.dump
   ```

3. **Verify backup size**
   ```bash
   ls -lh neon_backup.dump
   ```

---

### Phase 3: Import to Heroku

1. **Restore to Heroku**
   ```bash
   pg_restore \
     --verbose \
     --no-owner \
     --no-acl \
     -d "$(heroku config:get DATABASE_URL -a your-app-name)" \
     neon_backup.dump
   ```

2. **Verify data**
   ```bash
   heroku pg:psql -a your-app-name
   # Then run:
   \dt
   SELECT COUNT(*) FROM blend_actions;
   SELECT COUNT(*) FROM parsed_events;
   ```

---

### Phase 4: Update Code

#### 4.1 Update dependencies in `stellar-events-stream/package.json`

Remove:
- `@neondatabase/serverless`

Add:
- `pg` (if not present)
- `@types/pg` (dev dependency, if not present)

Update drizzle adapter:
- Change from `drizzle-orm/neon-http` to `drizzle-orm/node-postgres`

```bash
cd stellar-events-stream
npm uninstall @neondatabase/serverless
npm install pg
npm install -D @types/pg
```

#### 4.2 Update `stellar-events-stream/src/db/index.ts`

**Current:**
```typescript
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
```

**Change to:**
```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // Required for Heroku
});

export const db = drizzle(pool, { schema });
```

#### 4.3 Update `stellar-events-stream/src/db/migrate.ts`

**Current:**
```typescript
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
await sql`...`;
```

**Change to:**
```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Replace template literal queries with pool.query()
await pool.query(`...`);
```

#### 4.4 Update `.env` files

Update `DATABASE_URL` in:
- `.env`
- `stellar-events-stream/.env`

From Neon format:
```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

To Heroku format:
```
DATABASE_URL=postgres://user:pass@host.compute.amazonaws.com:5432/dbname
```

---

### Phase 5: Test

1. **Run migrations**
   ```bash
   cd stellar-events-stream
   npm run migrate
   ```

2. **Start the app locally**
   ```bash
   npm run dev
   ```

3. **Test key queries**
   - Verify blend_actions data
   - Verify views work correctly
   - Test any API endpoints that query the DB

---

### Phase 6: Deploy

1. **Deploy updated code** to your hosting platform

2. **Update environment variables** on hosting platform with new Heroku DATABASE_URL

3. **Verify production** is working

---

### Phase 7: Cleanup

1. **Keep Neon backup** for 1-2 weeks as fallback

2. **Delete Neon database** after confirming everything works
   - Go to Neon dashboard
   - Delete the project

---

## Rollback Plan

If migration fails:
1. Revert code changes (git checkout)
2. Restore original `DATABASE_URL` in environment
3. Neon data should still be intact

---

## Checklist

- [ ] Create Heroku Postgres addon
- [ ] Export Neon database
- [ ] Import to Heroku
- [ ] Verify data integrity
- [ ] Update `stellar-events-stream` dependencies
- [ ] Update `stellar-events-stream/src/db/index.ts`
- [ ] Update `stellar-events-stream/src/db/migrate.ts`
- [ ] Update local `.env` files
- [ ] Test locally
- [ ] Deploy
- [ ] Update production environment variables
- [ ] Verify production
- [ ] Delete Neon (after 1-2 weeks)

---

## Notes

- Heroku Essential 0 has 20 connection limit - should be fine for this app
- SSL is required for Heroku Postgres (`ssl: { rejectUnauthorized: false }`)
- Heroku uses `postgres://` prefix, not `postgresql://` (both work but be aware)
