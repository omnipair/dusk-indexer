# Runbooks

One file per failure that will actually happen. Each says how to recognise it,
what it breaks, what to do, and how to know it is over.

These are written for whoever is on call at the time, which may be someone who
has never seen this stack. They assume nothing beyond access to Railway and the
public API.

| Runbook | Recognise it by |
| --- | --- |
| [RPC provider outage](rpc-provider-outage.md) | `/status` reports `deployment-identity` degraded; keepers report `readyz` failing |
| [Indexer falling behind](indexer-lag.md) | `/status` reports `indexer-lag` and a growing `slotLag` |
| [Keeper wallet drained](keeper-wallet-drained.md) | A keeper's `executionError` names the lamport floor |
| [Program upgraded underneath the deployment](program-upgraded.md) | Every service refuses to start, or `deploymentIdentitySha256` changes |
| [Database full or unavailable](database-unavailable.md) | API 503s; ingestion cursor stops advancing |
| [Swaps reverting](swaps-reverting.md) | Users report failed swaps; `BrokenInvariant` 6047 in logs |

## The one number worth knowing

`GET /api/dusk/v1/status` answers "what is this deployment and how far behind
is it" in one request, and names which subsystem is degraded rather than
implying it with a status code. Start there.

```bash
curl -s https://dusk-api-production-291f.up.railway.app/api/dusk/v1/status | jq .data
```

A `degraded` array that is empty means ingestion, chain observation and the
deployment identity all agree. Anything in it names the runbook to open.
