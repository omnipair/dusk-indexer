# Dusk decoder boundary (Local Snapshot 0)

The Dusk ingestion decoder is compiled against the exact `dusk.json` and
`leverage_delegate.json` artifacts in `protocol/idl/`. Startup verifies both
artifact hashes against `protocol/protocol.lock.json`, then verifies every
Anchor event and instruction discriminator from its canonical preimage.

## Coverage

| Program | Events | Instructions | Field boundary |
| --- | ---: | ---: | --- |
| Dusk | 35/35 classified and decoded | 53/53 classified and decoded | Strict dynamic Borsh from the pinned IDL |
| Leverage delegate | 0 declared | 6/6 classified and decoded | Strict dynamic Borsh from the pinned IDL |

The decoder supports every type form used by these artifacts: structs, enums,
defined types, options, vectors, fixed arrays, bytes, strings, pubkeys, booleans,
and signed/unsigned integers through 128 bits. Integers are rendered as decimal
JSON strings so JavaScript consumers cannot lose precision. Pubkeys are rendered
as base58 strings. A known payload must consume all bytes; truncation, invalid
tags, excessive allocation lengths, excessive nesting, and trailing bytes are
reported as malformed rather than partially accepted.

This is full IDL field decoding, but it is intentionally **dynamic JSON**, not a
hand-maintained Rust projection type per event. Product projections should be a
separate versioned layer over canonical observations.

## Event transports

Local Snapshot 0 Dusk emits its events with Anchor `emit_cpi!`. The production
ingestion path must therefore inspect `meta.innerInstructions`, decode each
instruction's base58 data, identify the Dusk program, and pass the complete
instruction data and exact nested instruction path to
`PinnedIdlDecoder::decode_event_cpi_instruction`. The instruction starts with
Anchor's event-CPI tag, followed by the event discriminator and Borsh payload.

`PinnedIdlDecoder::decode_program_data_logs` is a secondary path for Anchor
`emit!`-style `Program data: <base64>` records. The caller must supply the real
outer message-instruction indexes in root invocation order. Transaction logs
alone do not prove those indexes, so the decoder does not invent them. Invocation
depth, program exits, base64, decoded sizes, and event ordinals are checked; stack
corruption resets attribution. Free-form `Program log:` text is never decoded as
an event.

## Persistence and failure behavior

Every successfully delimited event produces an `EventObservation` and a
`CanonicalObservationRecord` matching the columns introduced by migration 018:
the indivisible protocol identity, stable event key, exact instruction path and
ordinal, fork/commitment facts, payload hash, optional decoded JSON, raw event
bytes, source, and observation time.

Unknown discriminators, missing discriminators, and malformed known payloads are
retained with their raw bytes. Unknown data is not silently dropped and is not
routed into legacy Omnipair `Pair`/`UserPosition` decoders. Malformed base64 has
no byte envelope to retain, so it is returned as a line-indexed diagnostic.

## Next integration gate

Before enabling an RPC consumer, add captured Surfpool transactions for at least
one event from each product family and assert:

1. message and loaded-address resolution selects the correct program ID;
2. base58 inner-instruction data yields the same raw event bytes as RPC;
3. stack heights produce the expected nested instruction path;
4. replay produces the same event key and payload hash;
5. unknown and malformed observations reach `dusk_ingestion.event_observations`;
6. confirmed fork replacement rolls projections back, while finalized canonical
   observations remain immutable.

Account-state decoding and strongly typed product projections are deliberately
outside this slice. They must use the same protocol identity and pinned IDL, and
must be rebuilt from the same canonical replay path rather than legacy V2 schema
assumptions.
