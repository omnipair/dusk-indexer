import { CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { ParitySpec, ReleaseConfig, ServiceSpec } from './config.js';
import type { NetworkStack } from './network.js';

export class RegistryStack extends Stack {
  readonly repositories: Readonly<Record<string, ecr.Repository>>;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const repositories: Record<string, ecr.Repository> = {};
    for (const name of ['api', 'indexer', 'grpc', 'keeper']) {
      const repository = new ecr.Repository(this, name, {
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      repositories[name] = repository;
      new CfnOutput(this, `${name}Repository`, { value: repository.repositoryUri });
    }
    this.repositories = repositories;
    const provider = new iam.OpenIdConnectProvider(this, 'GitHub', {
      url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'],
    });
    // Verified repository OIDC settings use GitHub's immutable ID-based sub.
    const repositoryIds: Record<string, string> = { 'dusk-indexer': '1335315149', 'dusk-keepers': '1335315268' };
    for (const [repository, images] of Object.entries({ 'dusk-indexer': ['api', 'indexer', 'grpc'], 'dusk-keepers': ['keeper'] })) {
      const publisher = new iam.Role(this, `${repository}Publisher`, {
        assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:omnipair@205608207/${repository}@${repositoryIds[repository]}:ref:refs/heads/main`,
          },
        }),
        maxSessionDuration: Duration.hours(1),
        description: 'GitHub main-branch image publishing only; no deployment, runtime secrets or signing rights',
      });
      for (const image of images) repositories[image].grantPullPush(publisher);
      new CfnOutput(this, `${repository.replaceAll('-', '')}PublisherRoleArn`, { value: publisher.roleArn });
    }
  }
}

export class RuntimeSecretsStack extends Stack {
  readonly secrets: Readonly<Record<string, secrets.Secret>>;
  readonly previewWebhookSecret?: secrets.Secret;
  constructor(scope: Construct, id: string, props: StackProps & { readonly services: readonly ServiceSpec[] }) {
    super(scope, id, props);
    const values: Record<string, secrets.Secret> = {};
    for (const service of props.services) {
      const value = new secrets.Secret(this, service.name, {
        description: `Runtime configuration for ${service.name}; populate through the authenticated migration script before starting tasks`,
      });
      value.applyRemovalPolicy(RemovalPolicy.RETAIN);
      values[service.name] = value;
      new CfnOutput(this, service.name.replaceAll('-', '') + 'SecretArn', { value: value.secretArn });
    }
    if (props.services.some(service => service.name === 'dusk-api')) {
      this.previewWebhookSecret = new secrets.Secret(this, 'DuskPreviewWebhook', {
        description: 'Signature verification for owned Dusk Vercel preview deployment events',
        generateSecretString: { secretStringTemplate: JSON.stringify({ webhookId: null }), generateStringKey: 'secret' },
      });
      this.previewWebhookSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
      new CfnOutput(this, 'DuskPreviewWebhookSecretArn', { value: this.previewWebhookSecret.secretArn });
    }
    this.secrets = values;
  }
}

export class ServicesStack extends Stack {
  readonly services: Readonly<Record<string, ecs.BaseService>>;
  constructor(scope: Construct, id: string, props: StackProps & {
    readonly network: NetworkStack;
    readonly registry: RegistryStack;
    readonly runtimeSecrets: RuntimeSecretsStack;
    readonly specs: readonly ServiceSpec[];
    readonly parity: ParitySpec;
    readonly config: ReleaseConfig;
    readonly primary: boolean;
  }) {
    super(scope, id, props);
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.network.vpc,
      // Standard ECS CPU/memory metrics are sufficient for launch sizing;
      // enhanced Container Insights has an additional per-observation charge.
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
      ...(props.primary ? { defaultCloudMapNamespace: { name: 'dusk-mainnet.internal', type: discovery.NamespaceType.HTTP, useForServiceConnect: true } } : {}),
    });
    let capacityProvider: ecs.AsgCapacityProvider | undefined;
    if (props.primary) {
      const hostRole = new iam.Role(this, 'AppHostRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      });
      // Service Connect polling fails with the ordinary ecs:cluster condition
      // and with a task-set ARN grant. Use AWS's standard instance-role Poll
      // grant; this adds no other ECS actions or worker signing permissions.
      hostRole.addToPolicy(new iam.PolicyStatement({
        actions: ['ecs:Poll'],
        resources: ['*'],
      }));
      const launchTemplate = new ec2.LaunchTemplate(this, 'AppLaunchTemplate', {
        instanceType: new ec2.InstanceType('t3a.medium'),
        machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
        securityGroup: props.network.serviceGroup, role: hostRole,
        requireImdsv2: true,
        cpuCredits: ec2.CpuCredits.UNLIMITED,
        userData: ec2.UserData.forLinux(),
        // The ECS-optimized AL2023 AMI has a 30 GiB root snapshot.
        blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(30, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      });
      const group = new autoscaling.AutoScalingGroup(this, 'SharedAppHosts', {
        vpc: props.network.vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        minCapacity: 1, maxCapacity: 2, launchTemplate,
      });
      group.addUserData(
        "cat >> /etc/ecs/ecs.config <<'CONFIG'\nECS_ENABLE_TASK_IAM_ROLE=true\nECS_ENABLE_AWSLOGS_EXECUTIONROLE_OVERRIDE=true\nECS_RESERVED_MEMORY=384\nCONFIG",
        // The ECS agent uses its host role; containers receive task credentials
        // at 169.254.170.2 and must not access the host's IMDS credentials.
        "cat > /usr/local/sbin/dusk-block-task-imds <<'SCRIPT'\n#!/bin/bash\nset -euo pipefail\nfor interface in docker+ br+; do\niptables -C DOCKER-USER -i \"$interface\" -d 169.254.169.254/32 -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -i \"$interface\" -d 169.254.169.254/32 -j DROP\ndone\nSCRIPT",
        'chmod 700 /usr/local/sbin/dusk-block-task-imds',
        "mkdir -p /etc/systemd/system/ecs.service.d\ncat > /etc/systemd/system/ecs.service.d/task-isolation.conf <<'UNIT'\n[Service]\nExecStartPre=/usr/local/sbin/dusk-block-task-imds\nUNIT",
        'systemctl daemon-reload',
      );
      capacityProvider = new ecs.AsgCapacityProvider(this, 'SharedCapacity', {
        autoScalingGroup: group, enableManagedScaling: true, enableManagedTerminationProtection: false,
        enableManagedDraining: true, targetCapacityPercent: 100,
        minimumScalingStepSize: 1, maximumScalingStepSize: 1,
      });
      cluster.addAsgCapacityProvider(capacityProvider);
      new CfnOutput(this, 'AppAutoScalingGroup', { value: group.autoScalingGroupName });
    }
    const digests: Record<string, CfnParameter> = {};
    for (const kind of new Set(props.specs.map(imageKind)))
      digests[kind] = new CfnParameter(this, `${kind}ImageDigest`, { type: 'String', allowedPattern: '^sha256:[0-9a-f]{64}$', description: 'Reviewed, CI-tested immutable image digest' });
    const indexerCommit = new CfnParameter(this, 'indexerCommit', { type: 'String', allowedPattern: '^[0-9a-f]{40}$' });
    const services: Record<string, ecs.BaseService> = {};
    for (const spec of props.specs) {
      const limits = props.parity.sizing.services[spec.name];
      if (!limits || spec.replicas !== 1) throw new Error(`Service differs from reviewed parity inventory: ${spec.name}`);
      const kind = imageKind(spec);
      const profile = spec.sourcePublicSettings.KEEPER_PROFILE;
      const taskRole = new iam.Role(this, `${spec.name}Role`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': props.config.account } } }),
      });
      if (profile && profile !== 'sentinel') {
        const identity = props.config.kms[profile];
        if (!identity) throw new Error(`Missing KMS identity for ${profile}`);
        taskRole.addToPolicy(new iam.PolicyStatement({ actions: ['kms:GetPublicKey'], resources: [identity.keyArn] }));
        taskRole.addToPolicy(new iam.PolicyStatement({
          actions: ['kms:Sign'], resources: [identity.keyArn],
          conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } },
        }));
      }
      const task = props.primary
        ? new ecs.Ec2TaskDefinition(this, `${spec.name}Task`, {
          taskRole, networkMode: ecs.NetworkMode.BRIDGE,
          // The API's unsigned simulations and depth subprocess share this
          // task quota. Keep one core for them plus Service Connect headroom.
          ...(kind === 'grpc' ? { cpu: '320', memoryMiB: '384' } : spec.name === 'dusk-api' ? { cpu: '1280', memoryMiB: '1792' } : {}),
        })
        : new ecs.FargateTaskDefinition(this, `${spec.name}Task`, {
          cpu: Math.round(limits.vcpu * 1024), memoryLimitMiB: Math.round(limits.memoryGiB * 1024),
          taskRole, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
        });
      const usesServiceConnect = props.primary && ['dusk-api', 'dusk-grpc'].includes(spec.name);
      const runtime = props.runtimeSecrets.secrets[spec.name];
      const secretFields = profile
        ? profile === 'sentinel' ? ['SOLANA_RPC_HTTP_URL'] : ['SOLANA_RPC_HTTP_URL', 'DATABASE_URL', 'KEEPER_JUPITER_API_KEY']
        : ['DATABASE_URL', 'DUSK_RPC_URL', ...(['dusk-api', 'dusk-prices'].includes(spec.name)
          ? ['JUPITER_API_KEY', 'BIRDEYE_API_KEY'] : [])];
      const environment: Record<string, string> = {
        ...spec.sourcePublicSettings,
        NODE_ENV: 'production', DUSK_CLUSTER: 'mainnet-beta',
        DUSK_PROTOCOL_REVISION: 'mainnet-2026-11-19',
        DUSK_PROGRAM_ID: 'DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj',
        DUSK_IDL_HASH: 'feaeb5ddbdec18a7b1c103fdc2e09730114c57f7c4948e5f6ce2ef50368e18a0',
        DUSK_DEVNET_MOCK_ORACLE_ENABLED: 'false',
        DUSK_BUILD_REVISION: indexerCommit.valueAsString,
      };
      if (profile) {
        environment.KEEPER_MODE = 'shadow';
        if (profile === 'hlp-recovery' && props.config.hlpRecoveryMarket)
          environment.KEEPER_HLP_MARKET = props.config.hlpRecoveryMarket;
        environment.PORT = '8080';
        if (profile !== 'sentinel') {
          const identity = props.config.kms[profile];
          Object.assign(environment, { AWS_REGION: 'us-east-1', SIGNER_PROVIDER: 'aws-kms', SIGNER_KEY_ID: identity.keyArn, KEEPER_SIGNER_PUBLIC_KEY: identity.publicKey, KEEPER_SHADOW_PUBLIC_KEY: identity.publicKey });
        }
      } else if (kind === 'api') {
        environment.PORT = '3000';
        environment.CORS_ORIGIN = (props.config.browserOrigins ?? ['https://beta.omnipair.fi']).join(',');
      }
      if (kind === 'grpc') {
        environment.GRPC_PORT = '50051'; environment.PORT = '50051';
        environment.ALLOWED_ORIGINS = (props.config.browserOrigins ?? ['https://beta.omnipair.fi']).join(',');
        environment.DUSK_API_URL = 'http://api.dusk-mainnet.internal:3000';
      }
      const logGroup = new logs.LogGroup(this, `${spec.name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
      const container = task.addContainer(spec.name, {
        // A digest is a deploy-time parameter: build the @ reference explicitly
        // rather than asking CDK to distinguish an unresolved token from a tag.
        image: ecs.ContainerImage.fromRegistry(Fn.join('@', [props.registry.repositories[kind].repositoryUri, digests[kind].valueAsString])),
        environment,
        secrets: {
          ...Object.fromEntries(secretFields.map(field => [field, ecs.Secret.fromSecretsManager(runtime, field)])),
          ...(props.primary && spec.name === 'dusk-api' && props.runtimeSecrets.previewWebhookSecret
            ? { DUSK_VERCEL_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(props.runtimeSecrets.previewWebhookSecret, 'secret') } : {}),
        },
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: spec.name, mode: ecs.AwsLogDriverMode.NON_BLOCKING }),
        stopTimeout: Duration.seconds(90),
        ...(props.primary ? {
          cpu: profile ? 32 : kind === 'grpc' ? 64 : spec.name === 'dusk-api' ? 1024 : 64,
          memoryLimitMiB: spec.name === 'dusk-api' ? 1536 : kind === 'grpc' ? 128 : 512,
          ...(!usesServiceConnect ? { memoryReservationMiB: profile ? 32 : 64 } : {}),
        } : {}),
        ...(spec.entrypoint ? { command: spec.entrypoint.split(' ') } : {}),
      });
      props.registry.repositories[kind].grantPull(task.obtainExecutionRole());
      const port = kind === 'grpc' ? 50051 : kind === 'api' ? 3000 : 8080;
      if (!props.primary || ['dusk-api', 'dusk-grpc'].includes(spec.name))
        container.addPortMappings({ containerPort: port, ...(props.primary ? { hostPort: 0, name: 'api', appProtocol: ecs.AppProtocol.http } : {}) });
      const commonService = {
        cluster, desiredCount: spec.replicas,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100, maxHealthyPercent: 200,
      };
      const service = props.primary
        ? new ecs.Ec2Service(this, spec.name, {
          ...commonService, taskDefinition: task as ecs.Ec2TaskDefinition,
          capacityProviderStrategies: [{ capacityProvider: capacityProvider!.capacityProviderName, weight: 1 }],
          ...(usesServiceConnect ? { serviceConnectConfiguration: {
            services: spec.name === 'dusk-api' ? [{ portMappingName: 'api', discoveryName: 'api', dnsName: 'api.dusk-mainnet.internal', port: 3000 }] : [],
          } } : {}),
        })
        : new ecs.FargateService(this, spec.name, {
          ...commonService, taskDefinition: task as ecs.FargateTaskDefinition,
          assignPublicIp: true, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
          securityGroups: [props.network.serviceGroup],
        });
      services[spec.name] = service;
      // ECS divides service memory by MemoryReservation when one is present.
      // Workers reserve 32/64 MiB for placement but have a 512 MiB hard limit;
      // normalize that percentage before treating it as capacity pressure.
      const memory = service.metricMemoryUtilization();
      const memoryCapacity = usesServiceConnect ? memory : new cloudwatch.MathExpression({
        expression: `reserved * ${(profile ? 32 : 64) / 512}`,
        usingMetrics: { reserved: memory }, period: memory.period,
        label: 'Memory used (% of container limit)',
      });
      for (const [name, metric, threshold] of [
        ['CPUUtilization', service.metricCpuUtilization(), 85],
        ['MemoryUtilization', memoryCapacity, 85],
      ] as const) {
        new cloudwatch.Alarm(this, `${spec.name}${name}High`, {
          metric, threshold, evaluationPeriods: 3, datapointsToAlarm: 3,
          alarmDescription: `${spec.name}: sustained capacity pressure; review sizing before scaling single-writer workers`,
          treatMissingData: cloudwatch.TreatMissingData.MISSING,
        });
      }
    }
    this.services = services;
    if (props.primary) {
      // Service Connect clients discover endpoints at deployment time. Create
      // the API endpoint before starting its gRPC client deployment.
      services['dusk-grpc'].node.addDependency(services['dusk-api']);
      const loadBalancer = new elb.ApplicationLoadBalancer(this, 'LoadBalancer', {
        vpc: props.network.vpc, internetFacing: true, securityGroup: props.network.ingressGroup,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, idleTimeout: Duration.seconds(120),
        deletionProtection: true, dropInvalidHeaderFields: true,
      });
      const listener = loadBalancer.addListener('Https', {
        port: 443, protocol: elb.ApplicationProtocol.HTTPS, open: false,
        certificates: [acm.Certificate.fromCertificateArn(this, 'ApiCertificate', props.config.apiCertificateArn)],
        sslPolicy: elb.SslPolicy.RECOMMENDED_TLS,
        defaultAction: elb.ListenerAction.fixedResponse(404),
      });
      const apiTarget = listener.addTargets('Api', {
        priority: 10, conditions: [elb.ListenerCondition.hostHeaders(['api.dusk.omnipair.fi'])],
        port: 3000, protocol: elb.ApplicationProtocol.HTTP,
        targets: [services['dusk-api']], healthCheck: { path: '/api/dusk/v1/status', healthyHttpCodes: '200', interval: Duration.seconds(30) },
        deregistrationDelay: Duration.seconds(60),
      });
      const grpcWebTarget = listener.addTargets('GrpcWeb', {
        priority: 20, conditions: [elb.ListenerCondition.hostHeaders(['grpc.dusk.omnipair.fi']), elb.ListenerCondition.httpHeader('content-type', ['application/grpc-web*'])],
        port: 50051, protocol: elb.ApplicationProtocol.HTTP, protocolVersion: elb.ApplicationProtocolVersion.HTTP1,
        // tonic-web rejects an HTTP/1 GET without grpc-web content type with
        // HTTP400. This probe checks the web transport; the second target group
        // below still requires a successful real gRPC health response (code0).
        targets: [services['dusk-grpc']], healthCheck: { path: '/grpc.health.v1.Health/Check', healthyHttpCodes: '400' },
      });
      // Browser preflight has Access-Control-Request-Headers, but no grpc-web
      // Content-Type. Send OPTIONS to HTTP/1 so tonic's CORS layer can answer;
      // the native gRPC target group rejects non-gRPC requests at the ALB.
      listener.addAction('GrpcWebPreflight', {
        priority: 15,
        conditions: [elb.ListenerCondition.hostHeaders(['grpc.dusk.omnipair.fi']), elb.ListenerCondition.httpRequestMethods(['OPTIONS'])],
        action: elb.ListenerAction.forward([grpcWebTarget]),
      });
      const grpcTarget = listener.addTargets('Grpc', {
        priority: 30, conditions: [elb.ListenerCondition.hostHeaders(['grpc.dusk.omnipair.fi'])],
        port: 50051, protocol: elb.ApplicationProtocol.HTTP, protocolVersion: elb.ApplicationProtocolVersion.GRPC,
        targets: [services['dusk-grpc']], healthCheck: { path: '/grpc.health.v1.Health/Check', healthyGrpcCodes: '0' },
      });
      for (const [name, target] of [['Api', apiTarget], ['Grpc', grpcTarget]] as const) {
        new cloudwatch.Alarm(this, `${name}Unavailable`, {
          metric: target.metrics.unhealthyHostCount({ statistic: 'Maximum', period: Duration.minutes(1) }),
          threshold: 1, evaluationPeriods: 2, treatMissingData: cloudwatch.TreatMissingData.BREACHING,
          alarmDescription: `${name} target is unavailable; inspect ECS deployment and database/replay health`,
        });
      }
      new CfnOutput(this, 'OriginHostname', { value: loadBalancer.loadBalancerDnsName });
    }
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}

function imageKind(service: ServiceSpec): string {
  if (service.name === 'dusk-indexer') return 'indexer';
  if (service.name === 'dusk-grpc') return 'grpc';
  return service.sourcePublicSettings.KEEPER_PROFILE ? 'keeper' : 'api';
}
