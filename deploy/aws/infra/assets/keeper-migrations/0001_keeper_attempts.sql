BEGIN;

CREATE TABLE keeper_work_items (
    work_key CHAR(64) PRIMARY KEY,
    protocol_revision TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    job_kind TEXT NOT NULL,
    conflict_key TEXT NOT NULL,
    market TEXT NOT NULL,
    target TEXT NOT NULL,
    observed_slot BIGINT NOT NULL CHECK (observed_slot >= 0),
    expected_state_hash CHAR(64) NOT NULL,
    candidate_payload JSONB NOT NULL,
    discovered_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT keeper_work_key_lower_hex CHECK (work_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT keeper_state_hash_lower_hex CHECK (expected_state_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT keeper_job_kind_valid CHECK (
        job_kind IN (
            'leverage_liquidation',
            'lending_liquidation_trigger',
            'lending_liquidation_bid',
            'lending_liquidation_settle',
            'stop_loss',
            'take_profit',
            'auction_bid',
            'lifecycle',
            'sentinel'
        )
    ),
    CONSTRAINT keeper_logical_work_unique UNIQUE (
        protocol_revision,
        job_kind,
        conflict_key,
        expected_state_hash
    )
);

CREATE TABLE keeper_attempts (
    attempt_id UUID PRIMARY KEY,
    work_key CHAR(64) NOT NULL REFERENCES keeper_work_items(work_key),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    phase TEXT NOT NULL,
    next_step TEXT,
    event_sequence BIGINT NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
    signing_generation INTEGER NOT NULL DEFAULT 0 CHECK (signing_generation >= 0),
    blockhash TEXT,
    last_valid_block_height BIGINT CHECK (last_valid_block_height >= 0),
    signature TEXT,
    confirmed_slot BIGINT CHECK (confirmed_slot >= 0),
    row_version BIGINT NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT keeper_attempt_phase_valid CHECK (
        phase IN ('active', 'awaiting_reconciliation', 'outcome_pending_journal', 'complete')
    ),
    CONSTRAINT keeper_attempt_next_step_valid CHECK (
        next_step IS NULL OR next_step IN (
            'discover',
            'revalidate',
            'evaluate',
            'policy',
            'simulate',
            'lease',
            'sign',
            'submit',
            'confirm',
            'postcondition',
            'journal'
        )
    ),
    CONSTRAINT keeper_complete_has_no_next_step CHECK (
        phase <> 'complete' OR next_step IS NULL
    ),
    CONSTRAINT keeper_reconciliation_has_signature CHECK (
        phase <> 'awaiting_reconciliation' OR signature IS NOT NULL
    ),
    CONSTRAINT keeper_attempt_number_unique UNIQUE (work_key, attempt_number),
    CONSTRAINT keeper_attempt_identity_unique UNIQUE (attempt_id, work_key, attempt_number)
);

CREATE TABLE keeper_attempt_events (
    attempt_id UUID NOT NULL REFERENCES keeper_attempts(attempt_id),
    event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
    event_type TEXT NOT NULL,
    event_payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (attempt_id, event_sequence),
    CONSTRAINT keeper_event_payload_bounded CHECK (octet_length(event_payload::TEXT) <= 65536)
);

CREATE TABLE keeper_signing_generations (
    attempt_id UUID NOT NULL REFERENCES keeper_attempts(attempt_id),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    blockhash TEXT NOT NULL,
    last_valid_block_height BIGINT NOT NULL CHECK (last_valid_block_height >= 0),
    signature TEXT NOT NULL UNIQUE,
    submission_state TEXT NOT NULL,
    signed_at TIMESTAMPTZ NOT NULL,
    submitted_at TIMESTAMPTZ,
    reconciled_at TIMESTAMPTZ,
    confirmed_slot BIGINT CHECK (confirmed_slot >= 0),
    PRIMARY KEY (attempt_id, generation),
    CONSTRAINT keeper_submission_state_valid CHECK (
        submission_state IN (
            'signed_not_submitted',
            'submitted_unknown',
            'confirmed',
            'finalized_not_landed',
            'rejected_before_submit'
        )
    ),
    CONSTRAINT keeper_confirmed_generation_has_slot CHECK (
        submission_state <> 'confirmed' OR confirmed_slot IS NOT NULL
    )
);

CREATE TABLE keeper_outcomes (
    attempt_id UUID PRIMARY KEY,
    work_key CHAR(64) NOT NULL REFERENCES keeper_work_items(work_key),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    status TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    race_code TEXT,
    observed_slot BIGINT NOT NULL CHECK (observed_slot >= 0),
    finalized_slot BIGINT CHECK (finalized_slot >= 0),
    signature TEXT,
    signing_generation INTEGER NOT NULL CHECK (signing_generation >= 0),
    outcome_payload JSONB NOT NULL,
    journaled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT keeper_outcome_status_valid CHECK (
        status IN ('executed', 'skipped', 'retryable_failure', 'terminal_failure')
    ),
    CONSTRAINT keeper_race_code_valid CHECK (
        race_code IS NULL OR race_code IN (
            'account_changed',
            'account_closed',
            'position_already_closed',
            'order_already_closed',
            'trigger_no_longer_met',
            'obligation_no_longer_liquidatable',
            'auction_already_settled',
            'lease_contended',
            'duplicate_signature_confirmed'
        )
    ),
    CONSTRAINT keeper_executed_has_signature CHECK (
        status <> 'executed' OR (signature IS NOT NULL AND finalized_slot IS NOT NULL)
    ),
    CONSTRAINT keeper_outcome_matches_attempt FOREIGN KEY (
        attempt_id,
        work_key,
        attempt_number
    ) REFERENCES keeper_attempts (
        attempt_id,
        work_key,
        attempt_number
    )
);

CREATE INDEX keeper_attempts_active_idx
    ON keeper_attempts (phase, updated_at)
    WHERE phase <> 'complete';

CREATE UNIQUE INDEX keeper_one_open_attempt_per_work_idx
    ON keeper_attempts (work_key)
    WHERE phase <> 'complete';

CREATE INDEX keeper_work_conflict_idx
    ON keeper_work_items (protocol_revision, conflict_key, observed_slot DESC);

CREATE INDEX keeper_signing_reconciliation_idx
    ON keeper_signing_generations (submission_state, submitted_at)
    WHERE submission_state = 'submitted_unknown';

COMMIT;
