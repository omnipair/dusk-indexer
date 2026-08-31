# RPC provider outage

## Recognise it

`/status` returns 503 with `degraded: ["deployment-identity"]` and a
`deploymentError` naming a transport or rate-limit failure. Keepers fail
`/readyz` while `/healthz` still passes — that split is deliberate: the process
is alive, it just cannot see the chain.

Transient rate limiting looks the same as an outage for a few seconds. Treat it
as an outage only if it persists past a minute.

## What it breaks

Reads that need the chain: `/config`, `/markets/state`, and the deployment
envelope on every other response. **Indexed history keeps serving** — the
event stream is in the database and does not need the RPC. Keepers stop
discovering, which means they stop acting; nothing they have already sent is
affected.

## Do

1. Confirm it is the provider and not this deployment:

   ```bash
   curl -s -X POST "$DUSK_RPC_URL" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```

2. If the provider is down, switch `DUSK_RPC_URL` on `dusk-api` and
   `SOLANA_RPC_HTTP_URL` on every keeper to the fallback provider, then
   redeploy those services. Both variables take a plain HTTPS URL.
3. If the provider is rate limiting rather than down, raise
   `DISCOVERY_INTERVAL_MS` on the keepers before switching providers. Keepers
   poll far more often than the API does and are usually what tripped it.

## Over when

`/status` returns 200 with an empty `degraded`, and each keeper's `/readyz`
returns `ready`.

## Do not

Do not point devnet at a mainnet RPC to "get something working". The keepers
verify the deployment identity from chain and will refuse it, which is the
system working, but the wasted hour is avoidable.
