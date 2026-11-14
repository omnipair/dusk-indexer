import { spawn } from 'node:child_process';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

// Values stay in process memory and stdin, never command-line arguments,
// temporary files or error output. AWS CLI handles its own local login cache.
export async function commandJson(binary, args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' } });
    const deadline = setTimeout(() => child.kill(), 120000);
    const chunks = [];
    let bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    // Provider errors can echo URLs/arguments; return a fixed error instead.
    child.stderr.resume();
    child.on('error', () => reject(new Error(`${binary} failed; inspect authentication locally`)));
    child.on('close', code => {
      clearTimeout(deadline);
      if (code !== 0) return reject(new Error(`${binary} request failed; no provider details logged`));
      try {
        const value = Buffer.concat(chunks).toString('utf8').trim();
        resolve(value ? JSON.parse(value) : {});
      } catch { reject(new Error(`${binary} returned an invalid JSON response`)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

export function awsClient(profile) {
  const clients = new Map();
  // The CLI's login provider owns credential refresh. Export only into this
  // process's memory; do not write credentials or put them in argv/env files.
  let cachedCredentials;
  const credentials = async () => {
    if (!cachedCredentials || cachedCredentials.expiration.getTime() < Date.now() + 300000) {
      const value = await commandJson('aws', ['configure', 'export-credentials', '--profile', profile, '--format', 'process']);
      if (!value.AccessKeyId || !value.SecretAccessKey || !value.SessionToken || !value.Expiration)
        throw new Error('Expected temporary local AWS login credentials');
      cachedCredentials = { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken, expiration: new Date(value.Expiration) };
    }
    return cachedCredentials;
  };
  const operations = {
    'cloudformation:describe-stacks': [CloudFormationClient, DescribeStacksCommand],
    'secretsmanager:get-secret-value': [SecretsManagerClient, GetSecretValueCommand],
    'secretsmanager:put-secret-value': [SecretsManagerClient, PutSecretValueCommand],
    'sts:get-caller-identity': [STSClient, GetCallerIdentityCommand],
  };
  return async (region, service, operation, input = {}) => {
    const pair = operations[`${service}:${operation}`];
    if (!pair) throw new Error('Unsupported release-helper AWS operation');
    const [Client, Command] = pair;
    const key = `${region}:${service}`;
    if (!clients.has(key)) clients.set(key, new Client({ region, credentials, maxAttempts: 2, requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 } }));
    try {
      return await clients.get(key).send(new Command(input), { abortSignal: AbortSignal.timeout(45000) });
    } catch { throw new Error('AWS release-helper request failed; no provider details logged'); }
  };
}

export async function stackOutputs(aws, region, name) {
  const response = await aws(region, 'cloudformation', 'describe-stacks', { StackName: name });
  const stack = response.Stacks?.[0];
  if (!stack || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus))
    throw new Error(`Stack ${name} must be successfully deployed first`);
  return Object.fromEntries((stack.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
}
