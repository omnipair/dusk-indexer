# Dusk AWS release

**Approved design:** the owner authorized the shared ECS setup and a USD 400/month planning budget on November 15, 2026. All fourteen services, five signing keys and backups are retained. Provisioning and rollout remain subject to the release checks below. No deployment step creates a market.

The [shared ECS estimate](shared-cost-estimate.json) recomputes with `python3 scripts/estimate-shared.py`: USD 350.94/month at the stated usage, or USD 355.94 in the first month with certificate issuance. USD 400 is a planning amount, not a hard cap. Singapore uses a separate t3a.xlarge database and one shared t3a.medium ECS node; the Oregon daemon stays on Fargate.

This CDK project implements the reviewed [Railway parity snapshot](../railway-parity.json): one TimescaleDB, API, gRPC service, ingestion daemon, four projection workers and six native keeper profiles. Singapore hosts the database and twelve tasks; Oregon hosts the ingestion daemon. Vercel and v1 remain on their current infrastructure. Helius is reused.

The configuration is prospective. A successful synthesis or CI bootstrap test does not mean these resources are deployed. The core mainnet programs and SDK `2.27.0` are already deployed; this project does not redeploy them or create a market.

The two alert stacks require `AlertEmail1` and `AlertEmail2` parameters at deployment. They are `NoEcho` and must stay out of source/config examples. Supply both owner-approved destinations to both stacks; their SNS subscriptions require recipient confirmation. Singapore also creates the USD400 monthly budget with actual and forecast email warnings. Bootstrap uses `bootstrap-execution-policy.json`, with no external account trust and an explicit denial of KMS signing/key administration for the CloudFormation role.

GitHub publishers pin the verified owner/repository IDs in the immutable OIDC subject and the `main` ref. Both repositories report `use_immutable_subject=true`; legacy name-only subjects cannot authenticate. See [GitHub's immutable subject format](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims). A rename or transfer requires reviewing the new exact subject before changing trust.

## Review and validate

```sh
cd deploy/aws/infra
npm ci
cp release.config.example.json release.config.json
npm run typecheck
npm test
shellcheck assets/database.sh assets/keeper-migrations/initialize.sh test/bootstrap-database.sh
npm run synth -- --no-lookups --quiet
npm run synth -- --no-lookups --quiet -c services=true --output cdk.out.services
```

The example contains public account, certificate, KMS ARNs and Solana wallet addresses only. Optional `browserOrigins` lists exact HTTPS origins for production and a verified owned release preview; REST, Socket.IO and gRPC use the same allowlist. Never allow all Vercel hostnames. `release.config.json` is ignored. Keep private material out of it. The account-specific availability-zone lookup is checked in; changing regions or account requires new measured sizing, network review and actual AZ lookup. Review `cdk diff` before every deployment. Never use production hotswap, Express mode or a wildcard service deployment with placeholder image digests.

CI synthesizes both phases without AWS credentials, checks IAM/network/parity invariants, and starts the exact pinned PostgreSQL 17.11 / TimescaleDB 2.29.2 image using synthetic AWS responses. It verifies certificate trust and hostname refusal, rejection of non-TLS access, non-superuser roles, idempotent keeper migrations, readable logical backups and certificate reload. CI uses 128 MB shared buffers because its runner is smaller; production keeps the measured 5722 MB setting.

## Provision in order

1. **Cost and quota:** review [the estimate](costs.md), account and `cdk diff`. Singapore uses 6 standard EC2 vCPUs steady and up to 8 while replacing the app host. AWS approved the increase from 5 to 16 in case `179467571500763`. Oregon Fargate uses 0.25 vCPU. The owner approved USD 400/month as the planning budget; monitor actual usage and burst credits.
2. **Foundation:** authenticate using `aws login --profile dusk-mainnet`. Bootstrap CDK in account `009853298730` in both `ap-southeast-1` and `us-west-2`, with no external account trust. Run `npm run diff -- --profile dusk-mainnet --all`, inspect the changes, then deploy foundation stacks using `npm run deploy -- --profile dusk-mainnet --all`. The default app contains no ECS services. Database TLS needs an exportable ACM certificate for `db.dusk.omnipair.fi`: add its DNS-only validation CNAME in Cloudflare while CloudFormation waits. API/gRPC use the already-issued non-exportable certificate. Leave validation records for renewals. Do not publish a database traffic record; its Route 53 private zone is associated with both VPCs.
3. **Database and images:** use SSM Session Manager, not SSH. Check `systemctl status dusk-database` and query the three keeper migration receipts, database versions, TLS and retained volume mount. Run a logical backup and restore both dumps into isolated disposable databases. Inspect the restored ledger and schema; list-only CI validation does not replace this restore drill. Merge the reviewed backend/keeper PRs, wait for exact-main CI, then run `node scripts/configure-publishers.mjs --execute`. Dispatch each repository's AWS image publication workflow on main. It requires passing CI for that exact commit and has ECR-only OIDC rights. Record its source SHA, immutable image digests and scan results. It cannot deploy, retrieve runtime secrets or sign.
4. **Runtime and services:** run `node scripts/seed-runtime.mjs --helius-source-dir /absolute/path/to/existing/omnipair-indexer --execute`. The existing Railway-linked `mainnet-indexer` is read only; its Helius endpoint must attest mainnet genesis. Values pass directly to Secrets Manager through the AWS SDK in memory. Nothing is copied from the devnet database. Check every service's public settings and secret-field presence without printing values. Each signer receives only its own KMS key ARN and IAM role; sentinel receives no signer. Configure a real existing Jupiter key separately if a signed route needs one. Keep all keeper modes **shadow**. Review a service-enabled diff, then deploy only the two service stacks with all four `sha256:` image digests and the exact indexer Git commit supplied as CloudFormation parameters. Never substitute tags or ordinary core build output.
5. **Cutover:** verify private peering, API identity and replay coverage from slot `469350144`, native gRPC and browser gRPC-Web, metadata/logos, empty-state behavior, wallet connection and create-market preparation. Add proxied Cloudflare traffic CNAMEs for the new API/gRPC names only after the origins pass; enable gRPC and Full (strict) TLS. Update the Vercel production environment to exact mainnet SDK/program/identity/backend settings and test its preview before promoting. Preserve current devnet and v1. The owner creates the first market through the UI; no deployment script does so.

Deploy `DuskIndexerOregon` first and verify its deployment registration and heartbeat before starting `DuskServicesSingapore`; API health depends on that registration. The commands below show the parameters for both stacks; execute them separately in that order. Replace every placeholder with the reviewed workflow output:

```sh
npm run deploy -- --profile dusk-mainnet -c services=true \
  DuskServicesSingapore DuskIndexerOregon \
  --parameters 'DuskServicesSingapore:apiImageDigest=sha256:REPLACE_WITH_64_HEX' \
  --parameters 'DuskServicesSingapore:grpcImageDigest=sha256:REPLACE_WITH_64_HEX' \
  --parameters 'DuskServicesSingapore:keeperImageDigest=sha256:REPLACE_WITH_64_HEX' \
  --parameters 'DuskServicesSingapore:indexerCommit=REPLACE_WITH_40_HEX' \
  --parameters 'DuskIndexerOregon:indexerImageDigest=sha256:REPLACE_WITH_64_HEX' \
  --parameters 'DuskIndexerOregon:indexerCommit=REPLACE_WITH_40_HEX'
```

## Custody, operation and recovery

No deployer/program key enters AWS. Five non-exportable Ed25519 KMS keys remain in `us-east-1`, each restricted to its own task role, pure `ED25519_SHA_512` and `RAW` messages. Root/admin login credentials stay local. ECS execution roles read their own runtime secret and ECR images; task roles do not read the database administrator secret. The remote keeper TLS connector validates both the public chain and hostname even though its PostgreSQL URL enum is named `require`; Node/libpq/SQLx use `verify-full`.

The single database preserves source topology and has **no automatic standby/failover**. Network subnets cover two AZs, but the database volume and instance are in one AZ. AWS Backup retains daily EC2/EBS recovery points for 35 days; daily custom-format dumps go to a private, encrypted, versioned S3 bucket. Current dumps expire after 35 days; noncurrent versions can persist another 35. Test recovery before opening traffic. Retained volumes, buckets and secrets and stack termination protection prevent ordinary stack removal from deleting state, but do not replace recovery procedures.

For host failure, fence the old instance before mounting its retained data volume on one replacement in the same AZ. For AZ failure, restore an AWS Backup recovery point to an isolated volume/instance in another AZ, restore/apply the matching public configuration and database secrets, verify checksums/TLS/ledger and then update the private DNS record. A logical restore into the same TimescaleDB version must call `timescaledb_pre_restore()` and `timescaledb_post_restore()` as documented by Timescale. Keep native keepers paused until pending signatures are reconciled against finalized history. Never restart an alternate signer or discard the keeper journal to bypass an unresolved submission.

CloudWatch has per-service CPU/memory alarms, database EC2 status, disk pressure and missing logical-backup metrics. Outage topics in both compute regions send confirmations to the owner-selected recipients through NoEcho CloudFormation parameters. Both recipients must confirm each regional SNS subscription. The USD 400 monthly budget sends actual/forecast warnings directly to those addresses. Verify delivery; creating an alarm alone does not prove notification delivery. Also verify AWS Backup job status and the first successful restore. Standard ECS metrics are enabled; enhanced Container Insights is deliberately absent from the cost baseline. Review memory, CPU, DB connection count, free disk, replay lag and provider errors after launch. The source's 100 database connection limit and existing application pools are preserved; measure contention before increasing traffic or replicas.

Live keepers require the keeper repository's full signed E2E/frozen-lock gate, verified durable recovery, worker funding and explicit market/asset spending policies. The captured lock and 16 offline simulations do not satisfy that gate. Per-asset continuous auction policies remain a governance choice. Do not invent raw token limits, enable live mode, create a market or transfer authorities as part of this infrastructure migration.
