import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack, PeeringStack, WestRoutesStack } from '../lib/network.js';
import { DatabaseStack } from '../lib/database.js';
import { RegistryStack, RuntimeSecretsStack, ServicesStack } from '../lib/services.js';
import { AlertsStack } from '../lib/alerts.js';
import { loadParity, validateConfig, type ReleaseConfig } from '../lib/config.js';

const config = JSON.parse(readFileSync(new URL('../release.config.example.json', import.meta.url), 'utf8')) as ReleaseConfig;
const context = JSON.parse(readFileSync(new URL('../cdk.context.json', import.meta.url), 'utf8'));
context['@aws-cdk/core:defaultCrossStackReferences'] = 'strong';

test('service parity, immutable images, network boundaries and isolated signer permissions survive synthesis', () => {
  validateConfig(config);
  const app = new App({ context });
  const parity = loadParity();
  const common = { crossRegionReferences: true, terminationProtection: true };
  const primaryEnv = { account: config.account, region: config.primaryRegion };
  const westEnv = { account: config.account, region: config.indexerRegion };
  const primary = new NetworkStack(app, 'Primary', { ...common, env: primaryEnv, primary: true });
  const west = new NetworkStack(app, 'West', { ...common, env: westEnv, primary: false });
  const peer = new PeeringStack(app, 'Peer', { ...common, env: primaryEnv, primary, west });
  new WestRoutesStack(app, 'Routes', { ...common, env: westEnv, west, peering: peer });
  const database = new DatabaseStack(app, 'Database', { ...common, env: primaryEnv, primary, west, parity });
  const registry = new RegistryStack(app, 'Registry', { ...common, env: primaryEnv });
  const mainSpecs = parity.services.filter(s => !['timescaledb', 'dusk-indexer'].includes(s.name));
  const westSpecs = parity.services.filter(s => s.name === 'dusk-indexer');
  const mainSecrets = new RuntimeSecretsStack(app, 'Secrets', { ...common, env: primaryEnv, services: mainSpecs });
  const westSecrets = new RuntimeSecretsStack(app, 'WestSecrets', { ...common, env: westEnv, services: westSpecs });
  const browserOrigins = ['https://beta.omnipair.fi', 'https://dusk-webapp-git-feat-test-omnipair.vercel.app'];
  const hlpRecoveryMarket = 'GWrmPqBcmBgX3fcE3GPA6xgCUP3Cbd4DRvXHyfwu1795';
  const fleet = new ServicesStack(app, 'Fleet', { ...common, env: primaryEnv, network: primary, registry, runtimeSecrets: mainSecrets, specs: mainSpecs, parity, config: { ...config, browserOrigins, hlpRecoveryMarket }, primary: true });
  const indexer = new ServicesStack(app, 'Indexer', { ...common, env: westEnv, network: west, registry, runtimeSecrets: westSecrets, specs: westSpecs, parity, config, primary: false });
  app.synth();
  const fleetTemplate = Template.fromStack(fleet);
  const indexerTemplate = Template.fromStack(indexer);
  fleetTemplate.resourceCountIs('AWS::ECS::Service', 12);
  const fleetServices = Object.entries(fleetTemplate.findResources('AWS::ECS::Service')) as [string, any][];
  const apiService = fleetServices.find(([name]) => name.startsWith('duskapiService'))!;
  const grpcService = fleetServices.find(([name]) => name.startsWith('duskgrpcService'))!;
  assert.ok(grpcService[1].DependsOn.includes(apiService[0]), 'gRPC must discover the API endpoint after its service is created');
  const fleetTasks = Object.values(fleetTemplate.findResources('AWS::ECS::TaskDefinition')) as any[];
  const apiTask = fleetTasks.find(task => task.Properties.ContainerDefinitions[0].Name === 'dusk-api')!;
  const grpcTask = fleetTasks.find(task => task.Properties.ContainerDefinitions[0].Name === 'dusk-grpc')!;
  for (const task of fleetTasks) {
    const container = task.Properties.ContainerDefinitions[0];
    const market = container.Environment.find((entry:any) => entry.Name === 'KEEPER_HLP_MARKET');
    if (container.Name === 'dusk-hlp-recovery') assert.equal(market?.Value,hlpRecoveryMarket);
    else assert.equal(market,undefined,'hLP market selection must not leak to another profile');
  }
  assert.equal(apiTask.Properties.ContainerDefinitions[0].Environment.find((entry: any) => entry.Name === 'CORS_ORIGIN').Value, browserOrigins.join(','));
  assert.equal(grpcTask.Properties.ContainerDefinitions[0].Environment.find((entry: any) => entry.Name === 'ALLOWED_ORIGINS').Value, browserOrigins.join(','));
  assert.ok(apiTask.Properties.ContainerDefinitions[0].Secrets.some((s:any)=>s.Name==='DUSK_VERCEL_WEBHOOK_SECRET'));
  for (const task of fleetTasks.filter(t=>t!==apiTask))
    assert.ok(!task.Properties.ContainerDefinitions[0].Secrets.some((s:any)=>s.Name==='DUSK_VERCEL_WEBHOOK_SECRET'),'callback authority belongs only to the API');
  assert.equal(apiTask.Properties.Cpu, '1280', 'API task keeps one core plus Service Connect headroom');
  assert.equal(apiTask.Properties.ContainerDefinitions[0].Cpu, 1024);
  const reservedCpu = fleetTasks.reduce((sum, task) => sum + (task.Properties.Cpu
    ? Number(task.Properties.Cpu) : task.Properties.ContainerDefinitions.reduce((n: number, c: any) => n + (c.Cpu ?? 0), 0)), 0);
  assert.ok(reservedCpu <= 2048, 'all twelve services must still fit on one two-core app host');
  const alarms = Object.entries(fleetTemplate.findResources('AWS::CloudWatch::Alarm')) as [string, any][];
  const snapshotMemory = alarms.find(([name]) => name.startsWith('duskportfoliosnapshotsMemoryUtilizationHigh'))![1].Properties;
  assert.equal(snapshotMemory.Threshold,85);
  assert.equal(snapshotMemory.EvaluationPeriods,3);
  assert.equal(snapshotMemory.Metrics.find((metric:any)=>metric.Expression)?.Expression,'reserved * 0.125');
  const keeperMemory = alarms.find(([name]) => name.startsWith('dusklendingkeeperMemoryUtilizationHigh'))![1].Properties;
  assert.equal(keeperMemory.Metrics.find((metric:any)=>metric.Expression)?.Expression,'reserved * 0.0625');
  const apiMemory = alarms.find(([name]) => name.startsWith('duskapiMemoryUtilizationHigh'))![1].Properties;
  assert.equal(apiMemory.MetricName,'MemoryUtilization','Service Connect task alarms retain their complete task-memory denominator');
  assert.ok(fleetTasks.every(t => t.Properties.NetworkMode === 'bridge' && t.Properties.RequiresCompatibilities.includes('EC2')));
  const capacity = Object.values(fleetTemplate.findResources('AWS::AutoScaling::AutoScalingGroup')) as any[];
  fleetTemplate.resourceCountIs('AWS::AutoScaling::LaunchConfiguration', 0);
  fleetTemplate.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
  const appLaunch = Object.values(fleetTemplate.findResources('AWS::EC2::LaunchTemplate'))[0] as any;
  const appRoot = appLaunch.Properties.LaunchTemplateData.BlockDeviceMappings.find((mapping: any) => mapping.DeviceName === '/dev/xvda');
  assert.ok(appRoot.Ebs.VolumeSize >= 30, 'ECS-optimized AL2023 cannot launch below its root snapshot size');
  assert.equal(appRoot.Ebs.Encrypted, true);
  assert.equal(capacity.length, 1);
  assert.equal(capacity[0].Properties.MinSize, '1');
  assert.equal(capacity[0].Properties.MaxSize, '2');
  const fleetSerialized = JSON.stringify(fleetTemplate.toJSON());
  assert.ok(fleetSerialized.includes('t3a.medium'));
  assert.ok(fleetSerialized.includes('169.254.169.254/32'));
  assert.ok(!fleetSerialized.includes('"Privileged":true'));
  const webTargets = Object.entries(fleetTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')) as [string, any][];
  const apiTarget = webTargets.find(([, resource]) => resource.Properties.Port === 3000);
  assert.equal(apiTarget?.[1].Properties.HealthCheckPath, '/api/dusk/v1/status');
  const apiRoutes = readFileSync(new URL('../../../../api/src/routes/v1/duskRoutes.ts', import.meta.url), 'utf8');
  assert.match(apiRoutes, /router\.get\(\s*'\/status'/, 'ALB probe must be a registered readiness route');
  const webTarget = webTargets.find(([, resource]) => resource.Properties.Port === 50051 && resource.Properties.ProtocolVersion === 'HTTP1');
  assert.ok(webTarget);
  const listenerRules = Object.values(fleetTemplate.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')) as any[];
  const preflight = listenerRules.find(rule => rule.Properties.Conditions.some((condition: any) => condition.Field === 'http-request-method' && condition.HttpRequestMethodConfig.Values.includes('OPTIONS')));
  assert.ok(preflight, 'gRPC-Web preflight needs an HTTP/1 route before native gRPC');
  assert.ok(preflight.Properties.Conditions.some((condition: any) => condition.Field === 'host-header' && condition.HostHeaderConfig.Values.includes('grpc.dusk.omnipair.fi')));
  assert.equal(preflight.Properties.Actions[0].TargetGroupArn.Ref, webTarget[0]);
  indexerTemplate.resourceCountIs('AWS::ECS::Service', 1);
  assert.equal(parity.services.length, 14);
  for (const template of [fleetTemplate, indexerTemplate]) {
    const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition')) as any[];
    for (const task of tasks) {
      const container = task.Properties.ContainerDefinitions[0];
      assert.equal(container.Image['Fn::Join'][0], '@');
      assert.equal(container.Environment.find((e: any) => e.Name === 'DUSK_CLUSTER').Value, 'mainnet-beta');
      assert.equal(container.Environment.find((e: any) => e.Name === 'DUSK_DEVNET_MOCK_ORACLE_ENABLED').Value, 'false');
      const profile = container.Environment.find((e: any) => e.Name === 'KEEPER_PROFILE');
      if (profile) {
        assert.deepEqual(container.Environment.find((e: any) => e.Name === 'KEEPER_MODE').Value, { Ref: 'KeeperMode' });
        const parameters = template.toJSON().Parameters;
        assert.equal(parameters.KeeperMode.Default, 'shadow');
        assert.deepEqual(parameters.KeeperMode.AllowedValues, ['shadow','live']);
        const environment = Object.fromEntries(container.Environment.map((e:any)=>[e.Name,e.Value]));
        if (profile.Value !== 'sentinel') {
          assert.equal(environment.KEEPER_RISK_POLICY,'/app/config/risk-policy.json');
          assert.equal(environment.KEEPER_MINIMUM_LAMPORTS,'50000000');
          assert.equal(environment.KEEPER_MAX_SENDS_PER_PASS,'1');
        }
        const ceilingFields: Record<string,string[]> = {
          lending:['KEEPER_FLASH_MAX_REPAY','KEEPER_FLASH_MAX_PAYMENT_DEBIT'],
          leverage:['KEEPER_FLASH_MAX_REPAY','KEEPER_FLASH_MAX_PAYMENT_DEBIT'],
          'hlp-recovery':['KEEPER_HLP_MAX_SOCIALIZED_LOSS','KEEPER_HLP_MAX_PAYMENT_DEBIT'],
          'auction-arbitrage':['KEEPER_AUCTION_MAX_SOLD','KEEPER_AUCTION_MAX_PAYMENT'],
        };
        for (const field of ceilingFields[profile.Value] ?? [])
          assert.equal(environment[field],'18446744073709551615','retain the explicit owner-selected inventory ceiling');
        if (['lending','leverage'].includes(profile.Value)) assert.equal(environment.KEEPER_FLASH_SETTLEMENT,'inventory');
        const taskEntry = Object.entries(template.findResources('AWS::ECS::TaskDefinition'))
          .find(([,t]:any)=>t.Properties.ContainerDefinitions[0].Name===container.Name);
        const signingService = Object.values(template.findResources('AWS::ECS::Service'))
          .find((s:any)=>s.Properties.TaskDefinition.Ref===taskEntry?.[0]) as any;
        assert.equal(signingService.Properties.AvailabilityZoneRebalancing,'DISABLED');
        assert.equal(signingService.Properties.DeploymentConfiguration.MinimumHealthyPercent,0);
        assert.equal(signingService.Properties.DeploymentConfiguration.MaximumPercent,100);
        if (profile.Value==='sentinel') {
          assert.ok(!container.Environment.some((e:any)=>['SIGNER_PROVIDER','SIGNER_KEY_ID','KEEPER_RISK_POLICY'].includes(e.Name)));
          assert.ok(!(container.Secrets??[]).some((s:any)=>s.Name==='DATABASE_URL'));
        }
      }
      const providerSecrets = (container.Secrets ?? []).filter((secret: any) => ['JUPITER_API_KEY', 'BIRDEYE_API_KEY'].includes(secret.Name));
      if (['dusk-api', 'dusk-prices'].includes(container.Name)) {
        assert.deepEqual(providerSecrets.map((secret: any) => secret.Name).sort(), ['BIRDEYE_API_KEY', 'JUPITER_API_KEY']);
      } else assert.equal(providerSecrets.length, 0);
    }
  }
  const statements = (Object.values(fleetTemplate.findResources('AWS::IAM::Policy')) as any[])
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const serviceConnectPoll = statements.find(s => s.Action === 'ecs:Poll' && !s.Condition);
  assert.ok(serviceConnectPoll, 'Service Connect needs polling independent of the ordinary cluster context');
  assert.equal(serviceConnectPoll.Resource, '*');
  const signing = statements.filter(s => s.Action === 'kms:Sign');
  assert.equal(signing.length, 5);
  assert.equal(new Set(signing.map(s => s.Resource)).size, 5);
  for (const statement of signing) {
    assert.match(statement.Resource, /^arn:aws:kms:us-east-1:009853298730:key\//);
    assert.deepEqual(statement.Condition, { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } });
  }
  for (const stack of [primary, west]) {
    const resources = Template.fromStack(stack).toJSON().Resources;
    for (const resource of Object.values(resources) as any[]) {
      const rules = resource.Type === 'AWS::EC2::SecurityGroup' ? resource.Properties.SecurityGroupIngress ?? []
        : resource.Type === 'AWS::EC2::SecurityGroupIngress' ? [resource.Properties] : [];
      for (const rule of rules) assert.ok(!['0.0.0.0/0', '::/0'].includes(rule.CidrIp ?? rule.CidrIpv6));
    }
  }
  const db = Template.fromStack(database).toJSON().Resources;
  const volume = Object.values(db).find((r: any) => r.Type === 'AWS::EC2::Volume') as any;
  assert.equal(volume.Properties.Encrypted, true);
  assert.equal(volume.DeletionPolicy, 'Retain');
  const instance = Object.values(db).find((r: any) => r.Type === 'AWS::EC2::Instance') as any;
  assert.equal(instance.Properties.InstanceType, 't3a.xlarge');
  const launchTemplate = Object.values(db).find((r: any) => r.Type === 'AWS::EC2::LaunchTemplate') as any;
  assert.equal(launchTemplate.Properties.LaunchTemplateData.MetadataOptions.HttpTokens, 'required');
  const bucket = Object.values(db).find((r: any) => r.Type === 'AWS::S3::Bucket') as any;
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
  });
  const publishers = Object.values(Template.fromStack(registry).findResources('AWS::IAM::Role')) as any[];
  const subjects = publishers.filter(r => r.Properties.AssumeRolePolicyDocument.Statement.some((s: any) => s.Action === 'sts:AssumeRoleWithWebIdentity'))
    .map(r => r.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub']);
  assert.deepEqual(subjects.sort(), ['repo:omnipair@205608207/dusk-indexer@1335315149:ref:refs/heads/main', 'repo:omnipair@205608207/dusk-keepers@1335315268:ref:refs/heads/main']);
});

test('configuration rejects shared wallets, extra signers and mismatched geography', () => {
  const copy = () => structuredClone(config) as any;
  const shared = copy(); shared.kms.leverage = shared.kms.lending;
  assert.throws(() => validateConfig(shared), /distinct/);
  const extra = copy(); extra.kms.sentinel = extra.kms.lending;
  assert.throws(() => validateConfig(extra), /distinct/);
  const wrong = copy(); wrong.primaryRegion = 'us-east-1';
  assert.throws(() => validateConfig(wrong), /Railway/);
  for (const origin of ['*', 'https://*.vercel.app', 'https://beta.omnipair.fi/path', 'http://beta.omnipair.fi']) {
    const invalid = copy(); invalid.browserOrigins = [origin];
    assert.throws(() => validateConfig(invalid), /exact HTTPS/);
  }
});

test('hLP market configuration rejects URLs and malformed addresses', () => {
  for (const hlpRecoveryMarket of ['', 'https://example.com', 'not a market', '0'.repeat(44)])
    assert.throws(() => validateConfig({ ...config,hlpRecoveryMarket }),/Solana public address/);
});

test('approved budget and notification destinations stay separate from source material', () => {
  const app = new App({ context });
  const alerts = new AlertsStack(app, 'DuskAlertsTest', { env: { account: config.account, region: config.primaryRegion }, primary: true });
  const stack = new AlertsStack(app, 'DuskAlertsWestTest', { env: { account: config.account, region: config.indexerRegion }, primary: false });
  const template = Template.fromStack(alerts).toJSON();
  const budget = Object.values(template.Resources).find((r: any) => r.Type === 'AWS::Budgets::Budget') as any;
  assert.deepEqual(budget.Properties.Budget.BudgetLimit, { Amount: 400, Unit: 'USD' });
  for (const key of ['AlertEmail1', 'AlertEmail2']) {
    assert.equal(template.Parameters[key].NoEcho, true);
    assert.equal(template.Parameters[key].Default, '');
  }
  Template.fromStack(stack).resourceCountIs('AWS::Budgets::Budget', 0);
  const policy = JSON.parse(readFileSync(new URL('../bootstrap-execution-policy.json', import.meta.url), 'utf8'));
  assert.ok(policy.Statement.some((s: any) => s.Effect === 'Deny' && s.Action.includes('kms:Sign') && s.Action.includes('kms:ScheduleKeyDeletion')));
});
