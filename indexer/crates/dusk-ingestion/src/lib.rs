//! Protocol-pinned, fork-aware primitives for the Dusk indexer.
//!
//! This crate intentionally has no dependency on the legacy Omnipair decoder
//! or its `Pair`/`UserPosition` database model.

pub mod decoder;

use {
    serde::{Deserialize, Serialize},
    solana_pubkey::Pubkey,
    std::{env, fmt::Write, str::FromStr},
    thiserror::Error,
};

pub const PROTOCOL_REVISION: &str = "local-snapshot-0";
pub const DUSK_PROGRAM_ID: &str = "358bjJKXWxeAXAzteX1xTgyd9JNnjtzW8fnwCS8Da1mv";
pub const DUSK_IDL_SHA256: &str =
    "5e67579b6dbec5620a5578844cd56c44458a3167095d8db2e85fd76643d5473f";
pub const LEVERAGE_DELEGATE_PROGRAM_ID: &str = "EPGF9iFrbGnhWgC3To9rC9vxinEYuDHaz4RXgLPvuRkp";
pub const LEVERAGE_DELEGATE_IDL_SHA256: &str =
    "948b9475071daa318cbc9f0e3cc2f8d150191a4ec3dc54e63a661ea489cc5f4a";

const DUSK_IDL: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../protocol/idl/dusk.json"
));
const LEVERAGE_DELEGATE_IDL: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../protocol/idl/leverage_delegate.json"
));
const PROTOCOL_LOCK: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../protocol/protocol.lock.json"
));

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FoundationError {
    #[error("cluster must be 1-128 characters from [A-Za-z0-9._:-]")]
    InvalidCluster,
    #[error("invalid Solana program id: {0}")]
    InvalidProgramId(String),
    #[error("IDL hash must be 64 lowercase hexadecimal characters")]
    InvalidIdlHash,
    #[error("protocol revision must be 1-128 characters from [A-Za-z0-9._:-]")]
    InvalidProtocolRevision,
    #[error("configured protocol identity does not match vendored Local Snapshot 0")]
    ProtocolIdentityMismatch,
    #[error("vendored protocol artifact mismatch: {0}")]
    VendoredArtifactMismatch(String),
    #[error("invalid canonical event key: {0}")]
    InvalidEventKey(String),
    #[error("observation does not match the canonical event key")]
    EventKeyMismatch,
    #[error("same block/event occurrence produced different payloads")]
    PayloadConflict,
    #[error("same block hash was observed at different slots")]
    BlockSlotConflict,
    #[error("fork resolution winner is not one of the observed block hashes")]
    UnknownForkWinner,
    #[error("a finalized canonical observation cannot be replaced")]
    FinalizedForkViolation,
    #[error("protocol lock JSON is invalid: {0}")]
    InvalidProtocolLock(String),
    #[error("required identity configuration is missing: {0}")]
    MissingIdentityConfig(&'static str),
}

/// Runtime identity attached to every cursor, event, API response, and job.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProtocolIdentity {
    pub cluster: String,
    pub program_id: String,
    pub idl_hash: String,
    pub protocol_revision: String,
}

impl ProtocolIdentity {
    pub fn new(
        cluster: impl Into<String>,
        program_id: impl Into<String>,
        idl_hash: impl Into<String>,
        protocol_revision: impl Into<String>,
    ) -> Result<Self, FoundationError> {
        let identity = Self {
            cluster: cluster.into(),
            program_id: program_id.into(),
            idl_hash: idl_hash.into(),
            protocol_revision: protocol_revision.into(),
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn vendored_dusk(cluster: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(cluster, DUSK_PROGRAM_ID, DUSK_IDL_SHA256, PROTOCOL_REVISION)
    }

    pub fn vendored_leverage_delegate(cluster: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(
            cluster,
            LEVERAGE_DELEGATE_PROGRAM_ID,
            LEVERAGE_DELEGATE_IDL_SHA256,
            PROTOCOL_REVISION,
        )
    }

    pub fn validate(&self) -> Result<(), FoundationError> {
        validate_label(&self.cluster).map_err(|_| FoundationError::InvalidCluster)?;
        Pubkey::from_str(&self.program_id)
            .map_err(|_| FoundationError::InvalidProgramId(self.program_id.clone()))?;
        if !is_sha256(&self.idl_hash) {
            return Err(FoundationError::InvalidIdlHash);
        }
        validate_label(&self.protocol_revision)
            .map_err(|_| FoundationError::InvalidProtocolRevision)?;
        Ok(())
    }

    pub fn require_vendored_dusk(&self) -> Result<(), FoundationError> {
        self.validate()?;
        if self.program_id != DUSK_PROGRAM_ID
            || self.idl_hash != DUSK_IDL_SHA256
            || self.protocol_revision != PROTOCOL_REVISION
        {
            return Err(FoundationError::ProtocolIdentityMismatch);
        }
        Ok(())
    }
}

/// Startup configuration for the isolated Dusk ingestion path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityConfig {
    pub identity: ProtocolIdentity,
}

impl IdentityConfig {
    pub fn from_values(
        cluster: impl Into<String>,
        program_id: Option<String>,
        idl_hash: Option<String>,
        protocol_revision: Option<String>,
    ) -> Result<Self, FoundationError> {
        let identity = ProtocolIdentity::new(
            cluster,
            program_id.unwrap_or_else(|| DUSK_PROGRAM_ID.to_owned()),
            idl_hash.unwrap_or_else(|| DUSK_IDL_SHA256.to_owned()),
            protocol_revision.unwrap_or_else(|| PROTOCOL_REVISION.to_owned()),
        )?;
        identity.require_vendored_dusk()?;
        Ok(Self { identity })
    }

    /// `DUSK_CLUSTER` is intentionally required. The other three fields default
    /// to the vendored lock but remain configurable so a mismatch fails loudly.
    pub fn from_environment() -> Result<Self, FoundationError> {
        let cluster = env::var("DUSK_CLUSTER")
            .map_err(|_| FoundationError::MissingIdentityConfig("DUSK_CLUSTER"))?;
        Self::from_values(
            cluster,
            env::var("DUSK_PROGRAM_ID").ok(),
            env::var("DUSK_IDL_HASH").ok(),
            env::var("DUSK_PROTOCOL_REVISION").ok(),
        )
    }
}

/// The path is outer instruction index followed by each nested CPI index.
/// `event_ordinal` disambiguates multiple events emitted at the same path.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CanonicalEventKey {
    pub identity: ProtocolIdentity,
    pub transaction_signature: String,
    pub instruction_path: Vec<u16>,
    pub event_ordinal: u16,
}

impl CanonicalEventKey {
    pub fn new(
        identity: ProtocolIdentity,
        transaction_signature: impl Into<String>,
        instruction_path: Vec<u16>,
        event_ordinal: u16,
    ) -> Result<Self, FoundationError> {
        let key = Self {
            identity,
            transaction_signature: transaction_signature.into(),
            instruction_path,
            event_ordinal,
        };
        key.validate()?;
        Ok(key)
    }

    pub fn validate(&self) -> Result<(), FoundationError> {
        self.identity.validate()?;
        if self.transaction_signature.is_empty()
            || self.transaction_signature.len() > 128
            || self.transaction_signature.contains('|')
        {
            return Err(FoundationError::InvalidEventKey(
                "transaction signature is empty, too long, or contains a delimiter".into(),
            ));
        }
        if self.instruction_path.is_empty() {
            return Err(FoundationError::InvalidEventKey(
                "instruction path must include the outer instruction index".into(),
            ));
        }
        Ok(())
    }

    /// Stable across retries, commitment promotion, and alternate fork slots.
    pub fn stable_key(&self) -> String {
        let path = self
            .instruction_path
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(".");
        format!(
            "{}|{}|{}|{}|{}|{}|{}",
            self.identity.cluster,
            self.identity.program_id,
            self.identity.idl_hash,
            self.identity.protocol_revision,
            self.transaction_signature,
            path,
            self.event_ordinal
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Commitment {
    Processed,
    Confirmed,
    Finalized,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventObservation {
    pub key: CanonicalEventKey,
    pub slot: u64,
    pub blockhash: String,
    pub parent_slot: Option<u64>,
    pub commitment: Commitment,
    pub payload_hash: String,
    pub observed_at_unix_ms: u64,
    pub source: String,
}

impl EventObservation {
    pub fn validate(&self) -> Result<(), FoundationError> {
        self.key.validate()?;
        if self.blockhash.is_empty() || self.blockhash.contains('|') {
            return Err(FoundationError::InvalidEventKey(
                "blockhash is empty or contains a delimiter".into(),
            ));
        }
        if !is_sha256(&self.payload_hash) {
            return Err(FoundationError::InvalidEventKey(
                "payload hash is not a lowercase SHA-256 value".into(),
            ));
        }
        if self.source.is_empty() {
            return Err(FoundationError::InvalidEventKey(
                "observation source must not be empty".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestionDecision {
    InsertCanonical,
    Duplicate,
    PromoteCommitment {
        from: Commitment,
        to: Commitment,
    },
    /// Store the candidate, but do not move the canonical pointer until an RPC
    /// reconciliation identifies the winning blockhash.
    RecordForkCandidate {
        canonical_blockhash: String,
        candidate_blockhash: String,
    },
}

pub fn classify_observation(
    current: Option<&EventObservation>,
    incoming: &EventObservation,
) -> Result<IngestionDecision, FoundationError> {
    incoming.validate()?;
    let Some(current) = current else {
        return Ok(IngestionDecision::InsertCanonical);
    };
    current.validate()?;
    if current.key != incoming.key {
        return Err(FoundationError::EventKeyMismatch);
    }
    if current.blockhash != incoming.blockhash {
        return Ok(IngestionDecision::RecordForkCandidate {
            canonical_blockhash: current.blockhash.clone(),
            candidate_blockhash: incoming.blockhash.clone(),
        });
    }
    if current.slot != incoming.slot {
        return Err(FoundationError::BlockSlotConflict);
    }
    if current.payload_hash != incoming.payload_hash {
        return Err(FoundationError::PayloadConflict);
    }
    if incoming.commitment > current.commitment {
        return Ok(IngestionDecision::PromoteCommitment {
            from: current.commitment,
            to: incoming.commitment,
        });
    }
    Ok(IngestionDecision::Duplicate)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkResolution {
    KeepCanonical,
    ReplaceCanonical {
        orphaned_blockhash: String,
        replacement_blockhash: String,
        rollback_required: bool,
    },
}

/// Applies an authoritative RPC reconciliation result. Ingestion never chooses
/// a fork winner from slot height or arrival order alone.
pub fn resolve_fork(
    current: &EventObservation,
    candidate: &EventObservation,
    winning_blockhash: &str,
) -> Result<ForkResolution, FoundationError> {
    current.validate()?;
    candidate.validate()?;
    if current.key != candidate.key {
        return Err(FoundationError::EventKeyMismatch);
    }
    if current.blockhash == candidate.blockhash {
        return Ok(ForkResolution::KeepCanonical);
    }
    if winning_blockhash == current.blockhash {
        return Ok(ForkResolution::KeepCanonical);
    }
    if winning_blockhash != candidate.blockhash {
        return Err(FoundationError::UnknownForkWinner);
    }
    if current.commitment == Commitment::Finalized {
        return Err(FoundationError::FinalizedForkViolation);
    }
    Ok(ForkResolution::ReplaceCanonical {
        orphaned_blockhash: current.blockhash.clone(),
        replacement_blockhash: candidate.blockhash.clone(),
        rollback_required: true,
    })
}

#[derive(Deserialize)]
struct ProtocolLock {
    revision: String,
    programs: Vec<LockedProgram>,
}

#[derive(Deserialize)]
struct LockedProgram {
    name: String,
    #[serde(rename = "programId")]
    program_id: String,
    idl: LockedIdl,
}

#[derive(Deserialize)]
struct LockedIdl {
    sha256: String,
}

pub fn verify_vendored_protocol() -> Result<(), FoundationError> {
    verify_bytes("dusk", DUSK_IDL, DUSK_IDL_SHA256)?;
    verify_bytes(
        "leverage_delegate",
        LEVERAGE_DELEGATE_IDL,
        LEVERAGE_DELEGATE_IDL_SHA256,
    )?;
    let lock: ProtocolLock = serde_json::from_str(PROTOCOL_LOCK)
        .map_err(|error| FoundationError::InvalidProtocolLock(error.to_string()))?;
    if lock.revision != PROTOCOL_REVISION {
        return Err(FoundationError::VendoredArtifactMismatch(
            "protocol revision differs from the compiled constant".into(),
        ));
    }
    verify_locked_program(&lock, "dusk", DUSK_PROGRAM_ID, DUSK_IDL_SHA256)?;
    verify_locked_program(
        &lock,
        "leverage_delegate",
        LEVERAGE_DELEGATE_PROGRAM_ID,
        LEVERAGE_DELEGATE_IDL_SHA256,
    )
}

fn verify_locked_program(
    lock: &ProtocolLock,
    name: &str,
    program_id: &str,
    idl_hash: &str,
) -> Result<(), FoundationError> {
    let program = lock
        .programs
        .iter()
        .find(|program| program.name == name)
        .ok_or_else(|| {
            FoundationError::VendoredArtifactMismatch(format!(
                "{name} is absent from protocol.lock.json"
            ))
        })?;
    if program.program_id != program_id || program.idl.sha256 != idl_hash {
        return Err(FoundationError::VendoredArtifactMismatch(format!(
            "{name} identity differs from protocol.lock.json"
        )));
    }
    Ok(())
}

fn verify_bytes(name: &str, bytes: &[u8], expected: &str) -> Result<(), FoundationError> {
    let actual = sha256_hex(bytes);
    if actual != expected {
        return Err(FoundationError::VendoredArtifactMismatch(format!(
            "{name} IDL hash {actual} does not match {expected}"
        )));
    }
    Ok(())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let bytes = solana_sha256_hasher::hash(bytes).to_bytes();
    let mut encoded = String::with_capacity(64);
    for byte in bytes {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

fn validate_label(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(());
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ProtocolIdentity {
        ProtocolIdentity::vendored_dusk("surfpool-mainnet-fork").unwrap()
    }

    fn key(ordinal: u16) -> CanonicalEventKey {
        CanonicalEventKey::new(identity(), "transaction-signature", vec![3, 1], ordinal).unwrap()
    }

    fn observation(
        key: CanonicalEventKey,
        slot: u64,
        blockhash: &str,
        commitment: Commitment,
        payload: char,
    ) -> EventObservation {
        EventObservation {
            key,
            slot,
            blockhash: blockhash.into(),
            parent_slot: slot.checked_sub(1),
            commitment,
            payload_hash: payload.to_string().repeat(64),
            observed_at_unix_ms: 1,
            source: "test".into(),
        }
    }

    #[test]
    fn vendored_idls_and_lock_match_snapshot_zero() {
        verify_vendored_protocol().unwrap();
    }

    #[test]
    fn identity_config_defaults_to_vendored_values_and_rejects_drift() {
        let config = IdentityConfig::from_values("devnet", None, None, None).unwrap();
        assert_eq!(config.identity.program_id, DUSK_PROGRAM_ID);
        assert_eq!(config.identity.idl_hash, DUSK_IDL_SHA256);
        assert_eq!(
            IdentityConfig::from_values("devnet", None, Some("0".repeat(64)), None,),
            Err(FoundationError::ProtocolIdentityMismatch)
        );
    }

    #[test]
    fn canonical_key_ignores_slot_commitment_and_distinguishes_event_ordinal() {
        let first = key(0);
        let same = first.clone();
        let second = key(1);
        assert_eq!(first.stable_key(), same.stable_key());
        assert_ne!(first.stable_key(), second.stable_key());
    }

    #[test]
    fn same_block_promotes_commitment_without_reinserting() {
        let current = observation(key(0), 42, "block-a", Commitment::Processed, 'a');
        let incoming = observation(key(0), 42, "block-a", Commitment::Finalized, 'a');
        assert_eq!(
            classify_observation(Some(&current), &incoming).unwrap(),
            IngestionDecision::PromoteCommitment {
                from: Commitment::Processed,
                to: Commitment::Finalized,
            }
        );
    }

    #[test]
    fn retrying_the_same_observation_is_idempotent() {
        let current = observation(key(0), 42, "block-a", Commitment::Confirmed, 'a');
        assert_eq!(
            classify_observation(Some(&current), &current).unwrap(),
            IngestionDecision::Duplicate
        );
    }

    #[test]
    fn alternate_block_is_recorded_without_guessing_the_winner() {
        let current = observation(key(0), 42, "block-a", Commitment::Confirmed, 'a');
        let incoming = observation(key(0), 43, "block-b", Commitment::Confirmed, 'a');
        assert_eq!(
            classify_observation(Some(&current), &incoming).unwrap(),
            IngestionDecision::RecordForkCandidate {
                canonical_blockhash: "block-a".into(),
                candidate_blockhash: "block-b".into(),
            }
        );
    }

    #[test]
    fn authoritative_fork_replacement_requires_rollback() {
        let current = observation(key(0), 42, "block-a", Commitment::Confirmed, 'a');
        let candidate = observation(key(0), 43, "block-b", Commitment::Finalized, 'a');
        assert_eq!(
            resolve_fork(&current, &candidate, "block-b").unwrap(),
            ForkResolution::ReplaceCanonical {
                orphaned_blockhash: "block-a".into(),
                replacement_blockhash: "block-b".into(),
                rollback_required: true,
            }
        );
    }

    #[test]
    fn finalized_canonical_observation_cannot_be_replaced() {
        let current = observation(key(0), 42, "block-a", Commitment::Finalized, 'a');
        let candidate = observation(key(0), 43, "block-b", Commitment::Finalized, 'a');
        assert_eq!(
            resolve_fork(&current, &candidate, "block-b"),
            Err(FoundationError::FinalizedForkViolation)
        );
    }

    #[test]
    fn same_occurrence_with_different_payload_is_rejected() {
        let current = observation(key(0), 42, "block-a", Commitment::Confirmed, 'a');
        let incoming = observation(key(0), 42, "block-a", Commitment::Confirmed, 'b');
        assert_eq!(
            classify_observation(Some(&current), &incoming),
            Err(FoundationError::PayloadConflict)
        );
    }
}
