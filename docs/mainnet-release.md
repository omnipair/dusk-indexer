# Mainnet release — 14 November 2026

The active protocol revision is `mainnet-2026-11-14`, from Dusk commit
`0acc9057b53a0495571f1bbf8a18e5db0f2efd45`. The exact production bundle passed
the protocol release suite and both independent source verifications. Both
Anchor IDLs are published; the registry SDK is exactly `2.27.0`.

| Program | ID | Finalized deployment slot |
| --- | --- | --- |
| Dusk | `DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj` | 469349657 |
| Delegate | `DeLegABhDLREbDpwwcsbkHvDS5MwqKPAw1CJKoooUXFQ` | 469350143 |

`protocol.lock.json`, `compatible-deployment.json`, both source IDLs and the
quote runtime describe this same deployment. Replay starts at **469350144**.
The former devnet identity is preserved under
`protocol/archive/devnet-2026-11-14-main-grid/`; its history is never relabelled
or exposed as mainnet history.

## Infrastructure configuration

The AWS migration preserves the existing Dusk Railway service topology and
reuses the existing Helius subscription. See
[`aws-railway-parity.md`](aws-railway-parity.md) and the credential-free
`deploy/aws/railway-parity.json` inventory. The frontend stays on Vercel;
v1 is outside this migration.

Use a mainnet database and fresh identity-scoped cursors. The Railway project
named `dusk-devnet` remains devnet even though its environment is called
`production`; the project named `dusk` contains a Surfpool fork. Neither name
establishes a mainnet deployment.

Configure the daemon, API and read workers consistently:

```text
DUSK_CLUSTER=mainnet-beta
DUSK_PROTOCOL_REVISION=mainnet-2026-11-14
DUSK_PROGRAM_ID=DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj
DUSK_IDL_HASH=dfd05743bca263f84193acbe882d281cb532806928fa357fc4ce0f07a4ec383c
```

Set `DATABASE_URL`, the provider HTTP/WebSocket RPC URLs and provider secrets
through the service secret store. Never commit their values. The RPC genesis
must be `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. Configure public API
origins/CORS and price-provider access for the actual app deployment.

The migration entrypoint applies the canonical manifest. Migration 054 adds
the exact mainnet/genesis pair without modifying any applied migration. Startup
must register the checked deployment boundary; no lower cursor override is a
substitute for replay. Run the manifest twice to verify idempotence.

The default reference policy is `protocol/mainnet-price-references.json`.
It marks Circle's native Solana USDC at its explicit dollar peg; it does not
carry the old devnet SOL/META demo prices. Other assets require provider prices
or market-derived references. A configured override must match the active pin.
The USDC mint is documented by
[Circle](https://www.circle.com/multi-chain-usdc/solana).

## Acceptance

1. Run native tests, clippy, API tests, database integration and container CI.
   Disposable database tests must use an isolated database. Timescale tests run
   against the pinned Timescale image in CI.
2. Deploy the daemon, API and required read workers from the reviewed commit.
   Verify the deployment envelope includes both exact programs, IDL hashes,
   executable hashes, authorities and source slots.
3. Verify genesis/upgrade rejection, replay coverage from slot 469350144,
   confirmed/finalized reconciliation, stream freshness and restart recovery.
4. Point the app and keepers at this mainnet identity only after these checks
   pass. Do not weaken any protocol identity or observation-boundary guard.
5. The owner creates the first market through the UI. Coordinate that action
   for subsequent swap, lending, TP/SL, liquidation and portfolio smoke checks.
   This release does not create or fund a mainnet market.

Layout-17 synthetic test fixtures are labelled as synthetic and preserve their
financial inputs. Historical devnet captures remain unchanged and are not
deployment or transaction evidence for mainnet.
