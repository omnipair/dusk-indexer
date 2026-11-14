import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { awsClient, commandJson, stackOutputs } from './aws-cli.mjs';

const { values } = parseArgs({ options: {
  profile: { type: 'string', default: 'dusk-mainnet' },
  config: { type: 'string', default: 'release.config.json' },
  'provider-source-dir': { type: 'string' },
  execute: { type: 'boolean', default: false },
} });
try {
  if (!values.execute) {
    console.log('Plan: copy the existing Jupiter provider key to dusk-api and dusk-prices runtime secrets, preserving every other field. No secrets are printed. Use --execute and --provider-source-dir to apply.');
    process.exit(0);
  }
  if (!values['provider-source-dir']) throw new Error('Provider source directory is required');
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  const aws = awsClient(values.profile);
  const identity = await aws(config.primaryRegion, 'sts', 'get-caller-identity');
  if (identity.Account !== config.account) throw new Error('Unexpected account');
  const outputs = await stackOutputs(aws, config.primaryRegion, 'DuskSecretsSingapore');
  const existing = await commandJson('railway', ['variables', '--service', 'jup-proxy', '--environment', 'production', '--json'], { cwd: values['provider-source-dir'] });
  const fallback = await commandJson('railway', ['variables', '--service', 'Mainnet API', '--environment', 'production', '--json'], { cwd: values['provider-source-dir'] });
  if (typeof existing.JUPITER_API_KEY !== 'string' || !existing.JUPITER_API_KEY.trim()) throw new Error('Existing provider key is missing');
  for (const service of ['dusk-api', 'dusk-prices']) {
    const arn = outputs[service.replaceAll('-', '') + 'SecretArn'];
    if (!arn) throw new Error('Runtime secret is missing');
    const previous = await aws(config.primaryRegion, 'secretsmanager', 'get-secret-value', { SecretId: arn });
    const payload = JSON.parse(previous.SecretString);
    payload.JUPITER_API_KEY = existing.JUPITER_API_KEY;
    // Retain an existing optional fallback; no new provider subscription is needed.
    if (typeof fallback.BIRDEYE_API_KEY === 'string' && fallback.BIRDEYE_API_KEY.trim()) payload.BIRDEYE_API_KEY = fallback.BIRDEYE_API_KEY;
    else payload.BIRDEYE_API_KEY ??= '';
    await aws(config.primaryRegion, 'secretsmanager', 'put-secret-value', { SecretId: arn, SecretString: JSON.stringify(payload) });
    console.log(`Configured provider prices for ${service}; values omitted`);
  }
} catch {
  console.error('Provider price configuration failed. Check the local AWS/Railway login, reviewed account and source provider key. No secret values logged.');
  process.exitCode = 1;
}
