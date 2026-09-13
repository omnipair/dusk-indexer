\set ON_ERROR_STOP on
BEGIN;
INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
VALUES ('projection-test','program',repeat('a',64),'test-v1');
INSERT INTO dusk_ingestion.account_scans(cluster,program_id,idl_hash,protocol_revision,slot,blockhash,parent_slot,content_hash)
VALUES ('projection-test','program',repeat('a',64),'test-v1',100,'block100',99,repeat('b',64)) RETURNING scan_id AS first_scan \gset
INSERT INTO dusk_ingestion.account_observations(scan_id,account_pubkey,data_hash,raw_account)
VALUES (:first_scan,'position',repeat('c',64),'\x01');
SELECT dusk_ingestion.apply_account_scan(:first_scan,jsonb_build_array(jsonb_build_object('account','position','data_hash',repeat('c',64),'account_name','BorrowPosition','fields',jsonb_build_object('owner','alice','market','market','position_id','seed'),'projections','{}'::jsonb)));
SELECT dusk_ingestion.apply_account_scan(:first_scan,'[]'::jsonb); -- already applied: no double-write
DO $$ BEGIN
  IF (SELECT count(*) FROM dusk_ingestion.native_positions WHERE cluster='projection-test' AND owner='alice') <> 1 THEN RAISE EXCEPTION 'first scan did not create exactly one native position'; END IF;
END $$;
INSERT INTO dusk_ingestion.account_scans(cluster,program_id,idl_hash,protocol_revision,slot,blockhash,parent_slot,content_hash)
VALUES ('projection-test','program',repeat('a',64),'test-v1',102,'block102',100,repeat('d',64)) RETURNING scan_id AS closed_scan \gset
SELECT dusk_ingestion.apply_account_scan(:closed_scan,'[]'::jsonb);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dusk_ingestion.native_positions WHERE cluster='projection-test') THEN RAISE EXCEPTION 'complete empty scan did not close missing account'; END IF;
  IF NOT EXISTS (SELECT 1 FROM dusk_ingestion.native_accounts WHERE cluster='projection-test' AND closed AND source_slot=102) THEN RAISE EXCEPTION 'closure provenance missing'; END IF;
END $$;
-- A newly replayed old scan cannot resurrect the current position.
INSERT INTO dusk_ingestion.account_scans(cluster,program_id,idl_hash,protocol_revision,slot,blockhash,parent_slot,content_hash)
VALUES ('projection-test','program',repeat('a',64),'test-v1',101,'block101',100,repeat('e',64)) RETURNING scan_id AS old_scan \gset
INSERT INTO dusk_ingestion.account_observations(scan_id,account_pubkey,data_hash,raw_account)
VALUES (:old_scan,'position',repeat('c',64),'\x01');
SELECT dusk_ingestion.apply_account_scan(:old_scan,jsonb_build_array(jsonb_build_object('account','position','data_hash',repeat('c',64),'account_name','BorrowPosition','fields','{}'::jsonb,'projections','{}'::jsonb)));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dusk_ingestion.native_positions WHERE cluster='projection-test') THEN RAISE EXCEPTION 'out-of-order replay resurrected a closed account'; END IF;
END $$;
INSERT INTO dusk_ingestion.account_scans(cluster,program_id,idl_hash,protocol_revision,slot,blockhash,parent_slot,content_hash)
VALUES ('projection-test','program',repeat('a',64),'test-v1',102,'fork102',100,repeat('f',64));
DO $$ DECLARE scan bigint; BEGIN
  SELECT scan_id INTO scan FROM dusk_ingestion.account_scans WHERE cluster='projection-test' AND blockhash='fork102';
  BEGIN
    PERFORM dusk_ingestion.apply_account_scan(scan,'[]'::jsonb);
    RAISE EXCEPTION 'conflicting finalized scan was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'FINALIZED_INVARIANT:%' THEN RAISE; END IF;
  END;
END $$;
-- Event observations must survive a rejected canonical replacement.
INSERT INTO dusk_ingestion.event_observations(cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,slot,blockhash,parent_slot,commitment,event_name,payload_hash,source)
VALUES ('projection-test','program',repeat('a',64),'test-v1','event','sig',ARRAY[1,0,0],0,100,'block100',99,'finalized','Event',repeat('b',64),'test') RETURNING observation_id AS first_event \gset
INSERT INTO dusk_ingestion.canonical_events(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment)
VALUES ('projection-test','program',repeat('a',64),'test-v1','event',:first_event,'finalized');
INSERT INTO dusk_ingestion.event_observations(cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,slot,blockhash,parent_slot,commitment,event_name,payload_hash,source)
VALUES ('projection-test','program',repeat('a',64),'test-v1','event','sig',ARRAY[1,0,0],0,100,'fork100',99,'finalized','Event',repeat('b',64),'test');
DO $$ BEGIN
  BEGIN
    UPDATE dusk_ingestion.canonical_events SET observation_id=(SELECT observation_id FROM dusk_ingestion.event_observations WHERE cluster='projection-test' AND blockhash='fork100') WHERE cluster='projection-test';
    RAISE EXCEPTION 'finalized canonical replacement was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FINALIZED_INVARIANT:%' THEN RAISE; END IF; END;
  IF (SELECT count(*) FROM dusk_ingestion.event_observations WHERE cluster='projection-test') <> 2 THEN RAISE EXCEPTION 'contradictory observation was lost'; END IF;
END $$;
ROLLBACK;
