# Dusk AWS migration: Railway service parity

The migration scope is **Dusk only**. The frontend stays on Vercel and v1
stays on its existing infrastructure. Reuse the existing Helius subscription
and mainnet credentials. No additional RPC provider subscription is required.

`deploy/aws/railway-parity.json` records the source inventory, commands,
replicas, regions, non-secret runtime settings, database versions and observed
resource use. It is a proposed mapping, not evidence of a deployed AWS stack.
It contains variable names but excludes credential values.

## Preserve the running services

| Service | Replicas | Source location | AWS region |
| --- | ---: | --- | --- |
| TimescaleDB | 1 | Singapore | ap-southeast-1 |
| Dusk API | 1 | Singapore | ap-southeast-1 |
| Dusk gRPC | 1 | Singapore | ap-southeast-1 |
| Dusk indexer | 1 | US West | us-west-2 |
| Prices, market activity, portfolio snapshots, yield claims | 1 each | Singapore | ap-southeast-1 |
| Lending, leverage, hLP recovery, auction, lifecycle, sentinel | 1 each | Singapore | ap-southeast-1 |

The older `dusk-lending-trigger` and `dusk-lending-settler` are stopped on
Railway and remain excluded. The existing devnet services stay on their
reviewed snapshot branches throughout preparation and cutover.

The source database runs PostgreSQL **17.11** and TimescaleDB **2.29.2**. Its
official immutable image is
`timescale/timescaledb:2.29.2-pg17@sha256:bc8527e62f70f0766b29515077965025872fabb5349db421565f69ee273baf2d`.
Keep its Timescale functionality and `/var/lib/postgresql/data` mount. The
source volume ceiling is 50,000 MB; a 50-GiB encrypted AWS volume rounds that
capacity upward. Do not substitute plain managed PostgreSQL silently.

## Size from measured usage

The owner confirmed preserving services and settings while sizing compute
from observed use with headroom. Railway reports 24-vCPU / 24-GB ceilings
per service; those ceilings are not dedicated allocations.

The captured seven-day hourly samples put database memory around 6.8 GB,
with a highest sample of 7.22 GB and CPU sample of 6.39 vCPU. Its configured
shared buffers are 5,722 MB. The proposed database host has 8 vCPU and 16 GiB
RAM. API samples reached 1.29 GB and 0.47 vCPU; its proposed task has 1 vCPU
and 2 GiB. Other tasks have a proposed 0.25 vCPU and 0.5 GiB each.

These are devnet observations, not a mainnet capacity guarantee. Check CPU,
memory, queue age, indexing lag, database connections and storage after rollout.
The earlier estimate with duplicate API/gRPC instances and an RDS standby is
superseded. Price the actual mapping before creating compute resources.

## Mainnet release overrides

The topology is preserved while network-specific values move to the verified
mainnet identity from `docs/mainnet-release.md`:

- Use SDK 2.27.0, both agreed program IDs and replay floor 469350144.
- Start with a fresh mainnet database. Never copy devnet observations, mock
  prices, mock mints, market addresses, lookup-table references or cursors into
  the mainnet identity.
- Keep the existing worker intervals and service roles. Preserve the shadow
  keeper mode during migration; activate live signing only after the frozen
  lock and release gates pass. The owner creates the first market in the UI.
- Use the five existing KMS keys with distinct worker IAM roles; sentinel has
  no wallet. The keys are in us-east-1, independently of the compute region.
- Transfer required secrets directly between authenticated service APIs and
  AWS Secrets Manager. Do not export plaintext environment files or include
  credentials in task definitions, source, plans, command output or logs.

The two compute regions need private database connectivity. Keep database
ingress restricted to the application and indexer network paths. Verify HTTPS,
Socket.IO reconnects, gRPC transport, CORS, migrations, backups and a restore
before the production frontend cutover. Preserve the old deployments for
rollback; no Railway service deletion is part of the initial cutover.


## Approved shared compute

On November 15, the owner approved USD400/month as a planning budget. The database is a separate t3a.xlarge (4vCPU/16GiB); twelve Singapore application services remain separate ECS tasks on a shared t3a.medium (2vCPU/4GiB). The Oregon daemon stays on Fargate (0.25vCPU/0.5GiB). This preserves service counts, keys and backups while reducing reserved idle compute. The model is `deploy/aws/infra/shared-cost-estimate.json`; current rates and explicit usage assumptions give USD350.94/month. Database burst capacity is lower than the observed6.39-vCPU sample; verify replay/load behavior before promotion.
