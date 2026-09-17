/** Recover a legacy capture's full identity from its original build revision
 * and freshly verified pinned program accounts. Never relabel saved captures. */
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { deploymentEnvelope, deploymentIdentityFingerprint } from '../services/duskDeploymentService';
import { storeCaptureDeployment } from '../services/duskHistoryDeployment';

async function main() {
  const buildRevision = process.argv[2];
  if (!buildRevision?.trim() || process.argv.length !== 3) throw new Error('Provide the original price worker build revision');
  const pin = loadPinnedProtocol(),current = await deploymentEnvelope(0,{ fresh: true });
  const candidate = { ...current,buildRevision };
  const envelope = { ...candidate,deploymentIdentitySha256: deploymentIdentityFingerprint(candidate) };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await client.query(`SELECT count(*)::text AS captures FROM dusk_ingestion.price_capture_observations
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND deployment_identity_sha256=$5`,
      [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,envelope.deploymentIdentitySha256]);
    if (saved.rows[0].captures === '0') throw new Error('No saved captures match this reconstructed deployment identity');
    await storeCaptureDeployment(client,envelope);
    await client.query('COMMIT');
    console.log(JSON.stringify({ deploymentIdentitySha256: envelope.deploymentIdentitySha256,captures: saved.rows[0].captures }));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
main().catch(() => { console.error('Deployment registration failed; verify the original worker build, RPC pin and saved capture identity.'); process.exitCode=1; })
  .finally(() => pool.end());
