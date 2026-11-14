# Proposed Dusk AWS cost

**Superseded comparison:** this page describes the initial dedicated Fargate/8-vCPU proposal. The approved shared ECS design is [recorded separately](shared-cost-estimate.json) at USD 350.94/month estimated, with a USD 400/month planning budget. Do not use the older figures below to provision resources.

**Planning range: $650–$750/month before tax**, including an allowance for variable AWS usage. This is an estimate, not an accepted budget or spending cap. The exact service footprint has a **$573.35/month baseline**, using 730 hours and public on-demand rates captured on November 15, 2026. Compute/database resources have not been provisioned by this preparation.

| Component | Monthly baseline |
| --- | ---: |
| Singapore TimescaleDB host, c7i.2xlarge, 8 vCPU / 16 GiB | $300.47 |
| Singapore: API 1 vCPU / 2 GiB, eleven other tasks 0.25 vCPU / 0.5 GiB | $168.68 |
| Oregon: ingestion daemon 0.25 vCPU / 0.5 GiB | $9.01 |
| Singapore NAT gateway, hourly component | $43.07 |
| Singapore ALB, hourly component | $18.40 |
| Minimum four public IPv4 addresses | $14.60 |
| Encrypted gp3: 50 GiB data plus 20 GiB root | $6.72 |
| Sixteen runtime/database secrets | $6.40 |
| Five existing KMS keys, storage | $5.00 |
| Two private DNS zones | $1.00 |
| **Baseline subtotal before rounding individual rows** | **$573.35** |

Run `python3 scripts/estimate-monthly.py` to recompute from the service inventory and [captured rates](pricing-20261115.json). The rate file records AWS Price List SKUs, usage types and publication dates. No Savings Plan, reservation, Spot interruption tolerance, Free Tier or startup credit is assumed. The five KMS keys were already provisioned separately and incur their storage charge even before application compute starts.

The $650–$750 range adds a $76.65–$176.65 allowance for S3/ECR and incremental backup storage, CloudWatch logs/metrics/alarms, ALB capacity units, NAT data processing, cross-AZ and Oregon–Singapore database transfer, internet egress, API calls and temporary rolling tasks. These costs depend on mainnet activity and can exceed the range; devnet hourly memory/CPU samples do not predict mainnet request volume. NAT processing alone is $0.059/GB and ALB capacity is $0.008/LCU-hour in Singapore. Preserve inter-region placement for parity, but measure its database latency and transfer costs before treating it as the final optimized layout.

The API/gRPC ACM certificate has no certificate charge. The proposed exportable database certificate costs **$7 on issuance and again at renewal** under the current [ACM pricing](https://aws.amazon.com/certificate-manager/pricing/); validity and future renewal pricing can change. It is not yet issued. Do not describe that fee as a fixed annual price.

This is a service/settings match to Railway, **not a bill match**. Railway reported $92.85 of Dusk usage in its previous billing period; that period was not proof of a full month at today's steady footprint. AWS reserves the listed compute continuously, including the database's 8 vCPUs. Its sizing covers the observed hourly CPU maximum of 6.39 vCPUs and memory maximum of 7.22 GB with headroom; it does not reproduce the 24-vCPU/24-GB service ceilings or promise instantaneous peak capacity. There is one database and one API, with backups and private access, but no automatic database failover or extra replica.

Keep Vercel and the existing Helius subscription outside this incremental AWS estimate. No additional RPC subscription is required. Agree the monthly planning amount and alarm destination before starting paid compute; configure a billing alert afterward. A budget alarm is a notification, not an automatic spending limit.

Rate references: [Fargate](https://aws.amazon.com/fargate/pricing/), [EC2 on-demand](https://aws.amazon.com/ec2/pricing/on-demand/), [ELB](https://aws.amazon.com/elasticloadbalancing/pricing/), [VPC/NAT/IPv4](https://aws.amazon.com/vpc/pricing/), [EBS](https://aws.amazon.com/ebs/pricing/), [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/), [KMS](https://aws.amazon.com/kms/pricing/), [Route 53](https://aws.amazon.com/route53/pricing/).
