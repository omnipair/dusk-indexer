BEGIN;
-- Activity values every event at its own historical price. Keep that lookup
-- bounded as provider observations accumulate: the latest eligible quote can
-- be read in index order, including observation-id ties, without sorting the
-- mint's entire price history once per event.
CREATE INDEX dusk_activity_provider_price_lookup ON dusk_ingestion.price_observations
  (cluster,program_id,idl_hash,protocol_revision,mint,source_time DESC,observation_id DESC)
  WHERE quality='external-observation'
    AND (source LIKE 'dusk-provider.v1:jupiter:%' OR source LIKE 'dusk-provider.v1:birdeye:%')
    AND source_evidence->>'basis'='dusk-provider.v1'
    AND source_evidence->>'sourceCluster'='mainnet-beta';
COMMIT;
