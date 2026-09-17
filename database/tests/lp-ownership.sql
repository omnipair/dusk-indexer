\set ON_ERROR_STOP on
BEGIN;
INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
VALUES ('lp-test','dusk',repeat('1',64),'ownership-test');

DO $$
DECLARE first_scan BIGINT; transfer_scan BIGINT; authority_scan BIGINT; empty_scan BIGINT; older_scan BIGINT; conflicting_scan BIGINT;
BEGIN
  INSERT INTO dusk_ingestion.lp_token_scans(cluster,program_id,idl_hash,protocol_revision,market,lp_mint,token_kind,
    slot,blockhash,parent_slot,block_time,mint_slot,mint_supply,decimals,raw_mint,content_hash,account_count)
  VALUES ('lp-test','dusk',repeat('1',64),'ownership-test','market','mint','ylp',10,'block10',9,now(),10,100,9,''::bytea,repeat('a',64),1) RETURNING scan_id INTO first_scan;
  INSERT INTO dusk_ingestion.lp_token_observations VALUES (first_scan,'account-a','alice',100,false,true,repeat('a',64),''::bytea);
  PERFORM dusk_ingestion.apply_lp_token_scan(first_scan);
  PERFORM dusk_ingestion.apply_lp_token_scan(first_scan);

  INSERT INTO dusk_ingestion.lp_token_scans(cluster,program_id,idl_hash,protocol_revision,market,lp_mint,token_kind,
    slot,blockhash,parent_slot,block_time,mint_slot,mint_supply,decimals,raw_mint,content_hash,account_count)
  VALUES ('lp-test','dusk',repeat('1',64),'ownership-test','market','mint','ylp',11,'block11',10,now(),11,100,9,''::bytea,repeat('b',64),2) RETURNING scan_id INTO transfer_scan;
  INSERT INTO dusk_ingestion.lp_token_observations VALUES
    (transfer_scan,'account-a','alice',40,false,true,repeat('b',64),''::bytea),
    (transfer_scan,'account-b','bob',60,false,true,repeat('c',64),''::bytea);
  PERFORM dusk_ingestion.apply_lp_token_scan(transfer_scan);
  IF (SELECT amount FROM dusk_ingestion.native_lp_ownership WHERE cluster='lp-test' AND owner='alice')<>40
    OR (SELECT amount FROM dusk_ingestion.native_lp_ownership WHERE cluster='lp-test' AND owner='bob')<>60 THEN
    RAISE EXCEPTION 'Transfer ownership was not reflected';
  END IF;

  INSERT INTO dusk_ingestion.lp_token_scans(cluster,program_id,idl_hash,protocol_revision,market,lp_mint,token_kind,
    slot,blockhash,parent_slot,block_time,mint_slot,mint_supply,decimals,raw_mint,content_hash,account_count)
  VALUES ('lp-test','dusk',repeat('1',64),'ownership-test','market','mint','ylp',12,'block12',11,now(),12,100,9,''::bytea,repeat('d',64),1) RETURNING scan_id INTO authority_scan;
  INSERT INTO dusk_ingestion.lp_token_observations VALUES (authority_scan,'account-b','carol',100,false,false,repeat('d',64),''::bytea);
  PERFORM dusk_ingestion.apply_lp_token_scan(authority_scan);
  IF EXISTS(SELECT 1 FROM dusk_ingestion.native_lp_ownership WHERE cluster='lp-test' AND owner IN ('alice','bob')) THEN
    RAISE EXCEPTION 'Closed account or previous authority retained ownership';
  END IF;

  INSERT INTO dusk_ingestion.lp_token_scans(cluster,program_id,idl_hash,protocol_revision,market,lp_mint,token_kind,
    slot,blockhash,parent_slot,block_time,mint_slot,mint_supply,decimals,raw_mint,content_hash,account_count)
  VALUES ('lp-test','dusk',repeat('1',64),'ownership-test','market','mint','ylp',13,'block13',12,now(),13,0,9,''::bytea,repeat('e',64),0) RETURNING scan_id INTO empty_scan;
  PERFORM dusk_ingestion.apply_lp_token_scan(empty_scan);
  IF EXISTS(SELECT 1 FROM dusk_ingestion.native_lp_ownership WHERE cluster='lp-test') THEN RAISE EXCEPTION 'Empty mint snapshot did not clear balances'; END IF;

  INSERT INTO dusk_ingestion.lp_token_scans(cluster,program_id,idl_hash,protocol_revision,market,lp_mint,token_kind,
    slot,blockhash,parent_slot,block_time,mint_slot,mint_supply,decimals,raw_mint,content_hash,account_count)
  VALUES ('lp-test','dusk',repeat('1',64),'ownership-test','market','mint','ylp',9,'block9',8,now(),9,100,9,''::bytea,repeat('f',64),1) RETURNING scan_id INTO older_scan;
  INSERT INTO dusk_ingestion.lp_token_observations VALUES (older_scan,'account-a','alice',100,false,true,repeat('f',64),''::bytea);
  PERFORM dusk_ingestion.apply_lp_token_scan(older_scan);
  IF EXISTS(SELECT 1 FROM dusk_ingestion.native_lp_ownership WHERE cluster='lp-test') THEN RAISE EXCEPTION 'Older replay resurrected ownership'; END IF;

  INSERT INTO dusk_ingestion.lp_token_scans(cluster,program_id,idl_hash,protocol_revision,market,lp_mint,token_kind,
    slot,blockhash,parent_slot,block_time,mint_slot,mint_supply,decimals,raw_mint,content_hash,account_count)
  VALUES ('lp-test','dusk',repeat('1',64),'ownership-test','market','mint','ylp',13,'other-block13',12,now(),13,0,9,''::bytea,repeat('e',64),0) RETURNING scan_id INTO conflicting_scan;
  BEGIN
    PERFORM dusk_ingestion.apply_lp_token_scan(conflicting_scan);
    RAISE EXCEPTION 'Conflicting finalized ownership was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'FINALIZED_INVARIANT:%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE dusk_ingestion.lp_token_observations SET amount=99 WHERE scan_id=first_scan;
    RAISE EXCEPTION 'Finalized LP observation was rewritten';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'FINALIZED_INVARIANT:%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
