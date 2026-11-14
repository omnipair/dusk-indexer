import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { awsClient, commandJson, stackOutputs } from './aws-cli.mjs';

const { values } = parseArgs({ options: {
  profile: { type: 'string', default: 'dusk-mainnet' },
  config: { type: 'string', default: 'release.config.json' },
  'helius-source-dir': { type: 'string' },
  execute: { type: 'boolean', default: false },
} });
try {
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  const parity = JSON.parse(readFileSync(new URL('../../railway-parity.json', import.meta.url), 'utf8'));
  if (!values.execute) {
    console.log('Plan: verify the existing Helius mainnet endpoint; write separate runtime secrets for 13 Dusk services. No keys, devnet data or owner credentials are copied. Use --execute and --helius-source-dir to apply.');
    process.exit(0);
  }
  if (!values['helius-source-dir']) throw new Error('--helius-source-dir is required');
  const aws = awsClient(values.profile);
  const identity = await aws(config.primaryRegion, 'sts', 'get-caller-identity');
  if (identity.Account !== config.account) throw new Error('AWS account differs from the reviewed release configuration');
  const database = await stackOutputs(aws, config.primaryRegion, 'DuskDatabase');
  const primary = await stackOutputs(aws, config.primaryRegion, 'DuskSecretsSingapore');
  const west = await stackOutputs(aws, config.indexerRegion, 'DuskSecretsOregon');
  const password = async arn => {
    const secret = await aws(config.primaryRegion, 'secretsmanager', 'get-secret-value', { SecretId: arn });
    const value = JSON.parse(secret.SecretString).password;
    if (!/^[A-Za-z0-9]{32}$/.test(value)) throw new Error('Invalid generated database password');
    return value;
  };
  const appPassword = await password(database.AppPasswordArn);
  const keeperPassword = await password(database.KeeperPasswordArn);
  const existing = await commandJson('railway', ['variables', '--service', 'mainnet-indexer', '--environment', 'production', '--json'], { cwd: values['helius-source-dir'] });
  const candidates = Object.entries(existing).filter(([key, value]) => /RPC/i.test(key) && typeof value === 'string' && /^https:\/\//.test(value));
  let rpc;
  for (const [, value] of candidates) {
    const url = new URL(value);
    if (!/(^|\.)helius(-rpc)?\.com$/.test(url.hostname) && !/(^|\.)helius\.xyz$/.test(url.hostname)) continue;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }), signal: AbortSignal.timeout(15000) });
      if ((await response.json()).result === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') { rpc = value; break; }
    } catch { /* Never include provider URLs in exceptions or progress output. */ }
  }
  if (!rpc) throw new Error('Existing Helius endpoint did not attest Solana mainnet');
  const url = (keeper) => {
    const connection = new URL(`postgresql://${keeper ? 'keeper_writer' : 'dusk_app'}@db.dusk.omnipair.fi:5432/${keeper ? 'dusk_keeper_mainnet' : 'dusk_mainnet'}`);
    connection.password = keeper ? keeperPassword : appPassword;
    // postgres-native-tls verifies the certificate and hostname for keepers;
    // its URL parser accepts require, not libpq's verify-full enum.
    connection.searchParams.set('sslmode', keeper ? 'require' : 'verify-full');
    return connection.toString();
  };
  for (const service of parity.services.filter(s => s.name !== 'timescaledb')) {
    const isWest = service.name === 'dusk-indexer';
    const profile = service.sourcePublicSettings.KEEPER_PROFILE;
    const payload = profile ? { SOLANA_RPC_HTTP_URL: rpc } : { DATABASE_URL: url(false), DUSK_RPC_URL: rpc };
    if (profile && profile !== 'sentinel') Object.assign(payload, { DATABASE_URL: url(true), KEEPER_JUPITER_API_KEY: '' });
    // Jupiter auth is optional in shadow. Populate the worker's existing
    // provider key separately before signed execution if the route needs it.
    const secretId = (isWest ? west : primary)[service.name.replaceAll('-', '') + 'SecretArn'];
    if (!secretId) throw new Error('Runtime secret output is missing');
    await aws(isWest ? config.indexerRegion : config.primaryRegion, 'secretsmanager', 'put-secret-value', { SecretId: secretId, SecretString: JSON.stringify(payload) });
    console.log(`Configured ${service.name}; values omitted`);
  }
} catch {
  console.error('Runtime configuration failed. Verify local AWS/Railway login, completed foundation stacks, reviewed account/configuration and mainnet Helius access. No secret values logged.');
  process.exitCode = 1;
}
