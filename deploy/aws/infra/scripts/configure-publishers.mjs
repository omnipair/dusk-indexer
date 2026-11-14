import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { awsClient, commandJson, stackOutputs } from './aws-cli.mjs';

const { values } = parseArgs({ options: {
  profile: { type: 'string', default: 'dusk-mainnet' },
  config: { type: 'string', default: 'release.config.json' },
  execute: { type: 'boolean', default: false },
} });
try {
  if (!values.execute) {
    console.log('Plan: set public GitHub repository variables for main-branch OIDC image publishers. No credentials, secrets or deployment rights are installed. Use --execute after DuskRegistry completes.');
    process.exit(0);
  }
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  const aws = awsClient(values.profile);
  const identity = await aws(config.primaryRegion, 'sts', 'get-caller-identity');
  if (identity.Account !== config.account) throw new Error('Unexpected AWS account');
  const outputs = await stackOutputs(aws, config.primaryRegion, 'DuskRegistry');
  for (const [repository, images] of Object.entries({ 'dusk-indexer': ['api', 'indexer', 'grpc'], 'dusk-keepers': ['keeper'] })) {
    const variables = { DUSK_AWS_IMAGE_PUBLISHER_ROLE: outputs[`${repository.replaceAll('-', '')}PublisherRoleArn`] };
    for (const image of images) variables[`DUSK_ECR_${image.toUpperCase()}_REPOSITORY`] = outputs[`${image}Repository`];
    for (const [name, value] of Object.entries(variables)) {
      if (!value || !/^[a-zA-Z0-9:/._-]+$/.test(value)) throw new Error('Invalid public publisher output');
      // GitHub API arguments contain public ARNs/URIs only.
      await commandJson('gh', ['api', '--method', 'PATCH', `repos/omnipair/${repository}/actions/variables/${name}`, '--input', '-'], { input: { name, value } })
        .catch(() => commandJson('gh', ['api', '--method', 'POST', `repos/omnipair/${repository}/actions/variables`, '--input', '-'], { input: { name, value } }));
    }
    console.log(`Configured public image-publisher variables for omnipair/${repository}`);
  }
} catch {
  console.error('Publisher setup failed. Verify local login and completed DuskRegistry outputs. No credential values logged.');
  process.exitCode = 1;
}
