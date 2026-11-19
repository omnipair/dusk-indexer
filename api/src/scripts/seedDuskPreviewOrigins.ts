/** Bootstrap only from authenticated Vercel API results. No webhook credential is accepted or printed. */
import { readFileSync } from 'node:fs';
import pool from '../config/database';
import {
  PREVIEW_PROJECT_ID,
  recordPreviewEvent,
  verifiedBootstrapEvents,
} from '../services/duskPreviewOrigins';
async function run() {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      'Supply the verified Vercel deployment metadata JSON array',
    );
  const deployments = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(deployments) || deployments.length > 10000)
    throw new Error('Invalid deployment list');
  let registered = 0;
  for (const d of deployments) {
    const events = verifiedBootstrapEvents(d);
    if (!events.length) continue;
    for (const event of events)
      await recordPreviewEvent(event, 'verified-api-bootstrap');
    registered++;
  }
  console.log(
    JSON.stringify({
      registeredDeployments: registered,
      projectId: PREVIEW_PROJECT_ID,
    }),
  );
}
run()
  .catch(() => {
    console.error('Preview bootstrap failed; metadata and credentials omitted');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
