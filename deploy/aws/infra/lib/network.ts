import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

// Published by https://www.cloudflare.com/ips-v4, captured 2026-11-15 WITA.
export const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
] as const;

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly serviceGroup: ec2.SecurityGroup;
  readonly databaseGroup: ec2.SecurityGroup;
  readonly ingressGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: StackProps & { readonly primary: boolean }) {
    super(scope, id, props);
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.primary ? '10.42.0.0/16' : '10.43.0.0/16'),
      maxAzs: 2,
      natGateways: props.primary ? 1 : 0,
      subnetConfiguration: props.primary ? [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'services', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ] : [{ name: 'indexer', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      restrictDefaultSecurityGroup: true,
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });
    this.serviceGroup = new ec2.SecurityGroup(this, 'Services', { vpc: this.vpc, description: 'Dusk service tasks; no public task ingress' });
    this.databaseGroup = new ec2.SecurityGroup(this, 'Database', { vpc: this.vpc, description: 'PostgreSQL from Dusk services and private peering only' });
    this.ingressGroup = new ec2.SecurityGroup(this, 'Ingress', { vpc: this.vpc, description: 'HTTPS origin traffic from Cloudflare only' });
    if (props.primary) {
      for (const cidr of CLOUDFLARE_IPV4) this.ingressGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'Cloudflare HTTPS origin');
      this.serviceGroup.addIngressRule(this.ingressGroup, ec2.Port.tcp(3000), 'API from its load balancer');
      this.serviceGroup.addIngressRule(this.ingressGroup, ec2.Port.tcp(50051), 'gRPC from its load balancer');
      this.serviceGroup.addIngressRule(this.serviceGroup, ec2.Port.tcp(3000), 'gRPC deployment-envelope reads through private API discovery');
      this.serviceGroup.addIngressRule(this.ingressGroup, ec2.Port.tcpRange(32768, 65535), 'ALB to dynamically mapped ECS bridge ports');
      this.serviceGroup.addIngressRule(this.serviceGroup, ec2.Port.tcpRange(32768, 65535), 'Private ECS Service Connect proxy ports');
      this.databaseGroup.addIngressRule(this.serviceGroup, ec2.Port.tcp(5432), 'Application database connections');
      this.databaseGroup.addIngressRule(ec2.Peer.ipv4('10.43.0.0/16'), ec2.Port.tcp(5432), 'Oregon indexer through private peering');
    }
    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}

export class PeeringStack extends Stack {
  readonly peering: ec2.CfnVPCPeeringConnection;
  constructor(scope: Construct, id: string, props: StackProps & { readonly primary: NetworkStack; readonly west: NetworkStack }) {
    super(scope, id, props);
    this.peering = new ec2.CfnVPCPeeringConnection(this, 'Peering', {
      vpcId: props.primary.vpc.vpcId,
      peerVpcId: props.west.vpc.vpcId,
      peerRegion: props.west.region,
    });
    for (const [index, subnet] of [...props.primary.vpc.privateSubnets, ...props.primary.vpc.publicSubnets].entries())
      new ec2.CfnRoute(this, `Route${index}`, { routeTableId: subnet.routeTable.routeTableId, destinationCidrBlock: '10.43.0.0/16', vpcPeeringConnectionId: this.peering.ref });
  }
}

export class WestRoutesStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { readonly west: NetworkStack; readonly peering: PeeringStack }) {
    super(scope, id, props);
    for (const [index, subnet] of props.west.vpc.publicSubnets.entries())
      new ec2.CfnRoute(this, `Route${index}`, { routeTableId: subnet.routeTable.routeTableId, destinationCidrBlock: '10.42.0.0/16', vpcPeeringConnectionId: props.peering.peering.ref });
  }
}
