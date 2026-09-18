# Devnet hLP deposit-capacity rollout

Dusk PR #34, merged source `932018addb546e5906d345e3358d7980ddacc742`, was built and upgraded on devnet. Finalized ProgramData bytes match the artifact (zero-padded to the existing allocation) at slot **500313561**. The delegate slot, bytes and authority are unchanged. See `program-upgrade.json` for the signature and complete before/after attestation.

The additive IDL review confirms every existing instruction, account, event, error and type remains identical. Only the read-only hLP deposit-capacity preview and its new types were added. The SDK pin is 2.9.0.

This release registers a new protocol identity. Prior observations are never rewritten. Both previous price-history releases remain available through their own IDLs and envelopes, each bounded by the next program upgrade. Original saved witnesses from both releases pass decoder and PostgreSQL replay tests. The database held 18,423 captures for 9973dea and 3,856 for 1fa72d3 immediately after the upgrade.

Validation: 157 API unit tests; 31 Rust foundation tests plus daemon tests; Rust format/clippy; 89 unchanged database integration cases and both updated archive replay cases. Live native integration passed all 5 checks after refreshing account/LP discovery together. The deployed API and frontend parser returned 101 hourly candles across all three releases. A 0.01 test-USDC deposit and withdrawal finalized, restored the original hLP balance, and cost 10,000 lamports in network fees plus 4 raw test-USDC units. See the attached runtime evidence. No keepers were changed or run.

The Timescale history CI fixtures share hypertables and create overlapping chunks. Their files run sequentially to avoid chunk-DDL deadlocks between separate rollback-only transactions; every assertion remains enabled.
