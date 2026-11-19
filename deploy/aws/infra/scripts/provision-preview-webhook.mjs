// Provision a project-scoped callback. The callback secret stays in memory and Secrets Manager.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { awsClient, commandJson } from './aws-cli.mjs';
const projectId = 'prj_ztwzUn81e0xHqLa2NjoHbnqXy0EF',
  teamId = 'team_mUKFDc1HjGHQuYhtdIuDIh0x';
const endpoint = 'https://api.dusk.omnipair.fi/internal/vercel/previews';
const events = [
  'deployment.created',
  'deployment.succeeded',
  'deployment.cleanup',
];
const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'dusk-mainnet' },
    config: { type: 'string', default: 'release.config.json' },
    execute: { type: 'boolean', default: false },
  },
});
const config = JSON.parse(readFileSync(values.config, 'utf8'));
const requestAws = awsClient(values.profile);
const aws = (service, action, input = {}) =>
  requestAws(config.primaryRegion, service, action, input);
const vercel = (path, method = 'GET', input) =>
  commandJson(
    'vercel',
    [
      'api',
      path,
      '--scope',
      'omnipair',
      ...(input ? ['--method', method, '--input', '-'] : []),
    ],
    { input },
  );
try {
  if (!values.execute) {
    console.log(
      JSON.stringify({
        mode: 'plan',
        endpoint,
        projectId,
        events,
        secretDestination: 'DuskSecretsSingapore/DuskPreviewWebhookSecretArn',
      }),
    );
    process.exit(0);
  }
  if ((await aws('sts', 'get-caller-identity')).Account !== config.account)
    throw new Error('Wrong AWS account');
  const stack = (
    await aws('cloudformation', 'describe-stacks', {
      StackName: 'DuskSecretsSingapore',
    })
  ).Stacks[0];
  const arn = stack.Outputs.find(
    (v) => v.OutputKey === 'DuskPreviewWebhookSecretArn',
  )?.OutputValue;
  if (!arn)
    throw new Error('Deploy the reviewed webhook secret resource first');
  const current = JSON.parse(
    (await aws('secretsmanager', 'get-secret-value', { SecretId: arn }))
      .SecretString,
  );
  if (current.webhookId) {
    const hook = await vercel('/v1/webhooks/' + current.webhookId);
    if (
      current.endpoint !== endpoint ||
      current.projectId !== projectId ||
      current.teamId !== teamId ||
      hook.url !== endpoint ||
      hook.projectIds?.length !== 1 ||
      hook.projectIds[0] !== projectId ||
      events.some((e) => !hook.events.includes(e))
    )
      throw new Error('Existing callback configuration differs');
    console.log(
      JSON.stringify({
        mode: 'unchanged',
        webhookId: current.webhookId,
        projectId,
        endpoint,
      }),
    );
    process.exit(0);
  }
  const hook = await vercel('/v1/webhooks', 'POST', {
    url: endpoint,
    events,
    projectIds: [projectId],
  });
  try {
    if (
      typeof hook.id !== 'string' ||
      typeof hook.secret !== 'string' ||
      hook.secret.length < 16
    )
      throw new Error('Missing callback secret');
    await aws('secretsmanager', 'put-secret-value', {
      SecretId: arn,
      SecretString: JSON.stringify({
        secret: hook.secret,
        webhookId: hook.id,
        projectId,
        teamId,
        endpoint,
      }),
    });
  } catch (error) {
    if (hook.id)
      await commandJson('vercel', [
        'api',
        '/v1/webhooks/' + hook.id,
        '--method',
        'DELETE',
        '--scope',
        'omnipair',
      ]);
    throw error;
  }
  console.log(
    JSON.stringify({
      mode: 'configured',
      webhookId: hook.id,
      projectId,
      endpoint,
      secretArn: arn,
    }),
  );
} catch {
  console.error(
    'Preview callback configuration failed; secret and provider details omitted.',
  );
  process.exitCode = 1;
}
