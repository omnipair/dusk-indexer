import dotenv from 'dotenv';
import pool from '../config/database';

dotenv.config();

function readNumberArg(name: string, fallback: number): number {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }

  const parsed = Number(args[index + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number for ${name}: ${args[index + 1]}`);
  }
  return parsed;
}

interface SnapshotHealthRow {
  total_backfill_rows: number;
  high_debt_rows: number;
  high_debt_users: number;
  low_net_rows: number;
  low_net_users: number;
  max_backfill_debt_usd: string;
  min_backfill_net_value_usd: string;
}

interface SnapshotOutlierRow {
  user_address: string;
  bucket: Date | string;
  net_value_usd: string;
  debt_value_usd: string;
  source: string;
  quality: string;
}

async function main(): Promise<void> {
  const maxDebtUsd = readNumberArg('--max-debt-usd', 100_000);
  const minNetUsd = -readNumberArg('--min-net-abs-usd', 100_000);

  const health = await pool.query<SnapshotHealthRow>(
    `
      SELECT
        COUNT(*)::int AS total_backfill_rows,
        COUNT(*) FILTER (WHERE debt_value_usd > $1)::int AS high_debt_rows,
        COUNT(DISTINCT user_address) FILTER (WHERE debt_value_usd > $1)::int AS high_debt_users,
        COUNT(*) FILTER (WHERE net_value_usd < $2)::int AS low_net_rows,
        COUNT(DISTINCT user_address) FILTER (WHERE net_value_usd < $2)::int AS low_net_users,
        COALESCE(MAX(debt_value_usd), 0)::text AS max_backfill_debt_usd,
        COALESCE(MIN(net_value_usd), 0)::text AS min_backfill_net_value_usd
      FROM portfolio_value_snapshots
      WHERE source = 'backfill'
    `,
    [maxDebtUsd, minNetUsd]
  );

  const outliers = await pool.query<SnapshotOutlierRow>(
    `
      SELECT
        user_address,
        bucket,
        net_value_usd::text,
        debt_value_usd::text,
        source,
        quality
      FROM portfolio_value_snapshots
      WHERE source = 'backfill'
        AND (debt_value_usd > $1 OR net_value_usd < $2)
      ORDER BY GREATEST(debt_value_usd / $1, ABS(net_value_usd) / ABS($2)) DESC
      LIMIT 10
    `,
    [maxDebtUsd, minNetUsd]
  );

  const row = health.rows[0];
  console.log(JSON.stringify({
    thresholds: {
      maxBackfillDebtUsd: maxDebtUsd,
      minBackfillNetValueUsd: minNetUsd,
    },
    health: row,
    outliers: outliers.rows,
  }, null, 2));

  if (row.high_debt_rows > 0 || row.low_net_rows > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Portfolio snapshot health check failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
