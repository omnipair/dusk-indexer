import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { fileURLToPath } from 'node:url';
import type { Construct } from 'constructs';
import type { ParitySpec } from './config.js';
import type { NetworkStack } from './network.js';

export class DatabaseStack extends Stack {
  readonly appSecret: secrets.Secret;
  readonly keeperSecret: secrets.Secret;
  readonly database: ec2.Instance;
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: StackProps & {
    readonly primary: NetworkStack;
    readonly west: NetworkStack;
    readonly parity: ParitySpec;
  }) {
    super(scope, id, props);
    const network = props.primary;
    const rootSecret = this.password('RootPassword');
    this.appSecret = this.password('AppPassword');
    this.keeperSecret = this.password('KeeperPassword');
    this.certificate = new acm.Certificate(this, 'DatabaseCertificate', {
      domainName: 'db.dusk.omnipair.fi',
      validation: acm.CertificateValidation.fromDns(),
      allowExport: true,
    });
    const backups = new s3.Bucket(this, 'LogicalBackups', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: Duration.days(35), noncurrentVersionExpiration: Duration.days(35), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });
    const role = new iam.Role(this, 'DatabaseRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    for (const secret of [rootSecret, this.appSecret, this.keeperSecret]) secret.grantRead(role);
    role.addToPolicy(new iam.PolicyStatement({ actions: ['acm:ExportCertificate'], resources: [this.certificate.certificateArn] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'Dusk/Database' } } }));
    backups.grantPut(role, 'postgres/*');
    backups.grantRead(role, 'postgres/*');
    const script = new assets.Asset(this, 'DatabaseScript', { path: fileURLToPath(new URL('../assets/database.sh', import.meta.url)) });
    script.grantRead(role);
    const migrations = new assets.Asset(this, 'KeeperMigrations', { path: fileURLToPath(new URL('../assets/keeper-migrations', import.meta.url)) });
    migrations.grantRead(role);
    const subnet = network.vpc.privateSubnets[0];
    const data = new ec2.Volume(this, 'DataVolume', {
      availabilityZone: subnet.availabilityZone,
      size: Size.gibibytes(50),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.database = new ec2.Instance(this, 'Database', {
      vpc: network.vpc,
      vpcSubnets: { subnets: [subnet] },
      instanceType: new ec2.InstanceType('t3a.xlarge'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }),
      securityGroup: network.databaseGroup,
      role,
      requireImdsv2: true,
      creditSpecification: ec2.CpuCredits.UNLIMITED,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(20, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
    });
    new ec2.CfnVolumeAttachment(this, 'AttachData', { device: '/dev/sdf', instanceId: this.database.instanceId, volumeId: data.volumeId });
    const configuration = [
      `AWS_REGION=${this.region}`, `CERTIFICATE_ARN=${this.certificate.certificateArn}`,
      `ROOT_SECRET_ARN=${rootSecret.secretArn}`, `APP_SECRET_ARN=${this.appSecret.secretArn}`,
      `KEEPER_SECRET_ARN=${this.keeperSecret.secretArn}`, `BACKUP_BUCKET=${backups.bucketName}`,
      `DATABASE_IMAGE=${props.parity.database.pinnedImage}`,
    ].join('\n');
    this.database.addUserData(
      'set -euo pipefail',
      'dnf install -y docker jq openssl cronie unzip',
      'systemctl enable --now docker crond',
      `install -d -m 700 /run/dusk-db`,
      `aws s3 cp s3://${script.s3BucketName}/${script.s3ObjectKey} /usr/local/sbin/dusk-database --region ${this.region} --only-show-errors`,
      'chmod 700 /usr/local/sbin/dusk-database',
      'install -d -m 755 /opt/dusk-keeper-migrations',
      `aws s3 cp s3://${migrations.s3BucketName}/${migrations.s3ObjectKey} /run/dusk-db/migrations.zip --region ${this.region} --only-show-errors`,
      'unzip -oq /run/dusk-db/migrations.zip -d /opt/dusk-keeper-migrations',
      'chmod 755 /opt/dusk-keeper-migrations; chmod 644 /opt/dusk-keeper-migrations/*',
      '(cd /opt/dusk-keeper-migrations && sha256sum --check --status SHA256SUMS)',
      `cat > /etc/dusk-db.conf <<'CONFIG'\n${configuration}\nCONFIG`,
      // Match the retained EBS volume by serial, never by a guessed NVMe index.
      `volume_serial='${data.volumeId}'`,
      'volume_serial=${volume_serial//-/}',
      'device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$volume_serial"',
      'for attempt in $(seq 1 120); do test -e "$device" && break; sleep 2; done',
      'test -b "$device"',
      'if ! blkid "$device" > /dev/null; then mkfs.ext4 "$device"; fi',
      'mkdir -p /var/lib/dusk-postgres',
      'mount "$device" /var/lib/dusk-postgres',
      'uuid=$(blkid -s UUID -o value "$device")',
      'printf "UUID=%s /var/lib/dusk-postgres ext4 defaults,nofail 0 2\\n" "$uuid" >> /etc/fstab',
      'cat > /etc/systemd/system/dusk-database.service <<\'UNIT\'\n[Unit]\nAfter=network-online.target docker.service\nRequires=docker.service\nRequiresMountsFor=/var/lib/dusk-postgres\nStartLimitBurst=10\nStartLimitIntervalSec=300\n[Service]\nType=simple\nExecStart=/usr/local/sbin/dusk-database start\nExecStop=/usr/bin/docker stop --time 60 dusk-db\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=90\n[Install]\nWantedBy=multi-user.target\nUNIT',
      'systemctl daemon-reload',
      'systemctl enable --now dusk-database',
      'printf "0 3 * * * root /usr/local/sbin/dusk-database backup\\n0 */12 * * * root /usr/local/sbin/dusk-database refresh\\n*/5 * * * * root /usr/local/sbin/dusk-database metrics\\n" > /etc/cron.d/dusk-database',
    );
    const zone = new route53.PrivateHostedZone(this, 'DatabaseDns', { zoneName: 'db.dusk.omnipair.fi', vpc: network.vpc });
    const cfnZone = zone.node.defaultChild as route53.CfnHostedZone;
    cfnZone.addPropertyOverride('VPCs', [
      { VPCId: network.vpc.vpcId, VPCRegion: network.region },
      { VPCId: props.west.vpc.vpcId, VPCRegion: props.west.region },
    ]);
    new route53.ARecord(this, 'DatabaseAddress', { zone, target: route53.RecordTarget.fromIpAddresses(this.database.instancePrivateIp) });
    const vault = new backup.BackupVault(this, 'BackupVault', { removalPolicy: RemovalPolicy.RETAIN });
    const plan = new backup.BackupPlan(this, 'Backups', { backupVault: vault });
    plan.addRule(new backup.BackupPlanRule({ scheduleExpression: events.Schedule.cron({ hour: '2', minute: '0' }), deleteAfter: Duration.days(35) }));
    // An EC2 backup includes its attached EBS volumes; do not duplicate the
    // retained data volume in a second selection.
    plan.addSelection('DatabaseVolumes', { resources: [backup.BackupResource.fromEc2Instance(this.database)] });
    new cloudwatch.Alarm(this, 'DiskPressure', {
      metric: new cloudwatch.Metric({ namespace: 'Dusk/Database', metricName: 'DiskUsedPercent', statistic: 'Maximum', period: Duration.minutes(5) }),
      threshold: 80, evaluationPeriods: 3, treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    new cloudwatch.Alarm(this, 'LogicalBackupMissing', {
      metric: new cloudwatch.Metric({ namespace: 'Dusk/Database', metricName: 'LogicalBackupSuccess', statistic: 'Sum', period: Duration.days(1) }),
      threshold: 1, evaluationPeriods: 2, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    new cloudwatch.Alarm(this, 'DatabaseStatus', {
      metric: new cloudwatch.Metric({ namespace: 'AWS/EC2', metricName: 'StatusCheckFailed', dimensionsMap: { InstanceId: this.database.instanceId }, statistic: 'Maximum', period: Duration.minutes(1) }),
      threshold: 1, evaluationPeriods: 2,
    });
    new CfnOutput(this, 'AppPasswordArn', { value: this.appSecret.secretArn });
    new CfnOutput(this, 'KeeperPasswordArn', { value: this.keeperSecret.secretArn });
    new CfnOutput(this, 'InstanceId', { value: this.database.instanceId });
    new CfnOutput(this, 'DatabaseCertificateArn', { value: this.certificate.certificateArn });
    new CfnOutput(this, 'BackupBucket', { value: backups.bucketName });
  }

  private password(id: string): secrets.Secret {
    const secret = new secrets.Secret(this, id, {
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'password', passwordLength: 32, excludePunctuation: true },
    });
    secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return secret;
  }
}
