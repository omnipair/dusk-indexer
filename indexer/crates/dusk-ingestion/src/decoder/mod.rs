//! IDL-pinned Dusk transaction decoding.
//!
//! This module is deliberately isolated from the legacy Omnipair decoder. It
//! accepts only the two program identities pinned by Local Snapshot 0 and
//! retains every raw envelope, including unknown and malformed events.

mod accounts;
mod borsh;
mod logs;
mod projections;

use {
    crate::{
        sha256_hex, verify_vendored_protocol, CanonicalEventKey, Commitment, EventObservation,
        FoundationError, ProtocolIdentity, DUSK_IDL, DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_IDL,
        LEVERAGE_DELEGATE_PROGRAM_ID,
    },
    borsh::{DecodeLimits, TypeRegistry},
    serde::{Deserialize, Serialize},
    serde_json::Value,
    solana_sha256_hasher::hash,
    std::collections::BTreeMap,
    thiserror::Error,
};
pub use {
    accounts::{
        AccountDecodeStatus, AccountFreshness, AccountLayoutScope, AccountObservationContext,
        DecodedAccountEnvelope,
    },
    logs::{LogDecodeOutput, LogDiagnostic, LogDiagnosticKind},
    projections::{
        AccountProjections, AmmKind, AssetSide, AuctionDestination,
        BorrowLiquidationDiscoveryProjection, BorrowPortfolioProjection, KeeperDiscoveryProjection,
        LeverageDelegationPortfolioProjection, LeverageLiquidationDiscoveryProjection,
        LeverageOrderDiscoveryProjection, LeverageOrderPortfolioProjection,
        LeveragePortfolioProjection, MarketAssetProjection, MarketProjection, PortfolioProjection,
        ProposalExecutionDiscoveryProjection, ProposalSupportPortfolioProjection,
        ProtocolAuctionConfigDiscoveryProjection, ProtocolAuctionLaneProjection,
        ReferralAccrualPortfolioProjection, ReferralPartnerPortfolioProjection, RevenueSource,
        SignedInteger, UnsignedInteger, YieldPortfolioProjection,
    },
};

/// Anchor's `emit_cpi!` instruction prefix. Anchor interprets the first eight
/// bytes of `sha256("anchor:event")` as a big-endian `u64`, then writes that
/// integer little-endian into instruction data (so the digest prefix reverses).
pub const ANCHOR_EVENT_CPI_TAG: [u8; 8] = [228, 69, 165, 46, 81, 203, 154, 29];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinnedProgram {
    Dusk,
    LeverageDelegate,
}

impl PinnedProgram {
    pub const fn program_id(self) -> &'static str {
        match self {
            Self::Dusk => DUSK_PROGRAM_ID,
            Self::LeverageDelegate => LEVERAGE_DELEGATE_PROGRAM_ID,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DecoderError {
    #[error(transparent)]
    Foundation(#[from] FoundationError),
    #[error("invalid pinned IDL: {0}")]
    InvalidIdl(String),
    #[error("program {0} is not pinned by this decoder")]
    UnpinnedProgram(String),
    #[error("event-CPI data must begin with Anchor's 8-byte event tag")]
    NotAnchorEventCpi,
    #[error("event ordinal overflow")]
    EventOrdinalOverflow,
    #[error("invalid account observation context: {0}")]
    InvalidAccountContext(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventTransport {
    AnchorEventCpi,
    ProgramDataLog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventDecodeStatus {
    Decoded,
    UnknownDiscriminator,
    MissingDiscriminator,
    MalformedKnownPayload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionDecodeStatus {
    Decoded,
    UnknownDiscriminator,
    MissingDiscriminator,
    AnchorEventCpi,
    MalformedKnownArguments,
}

/// Transaction/block facts supplied by the RPC ingestion boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransactionObservationContext {
    pub transaction_signature: String,
    pub slot: u64,
    pub blockhash: String,
    pub parent_slot: Option<u64>,
    pub commitment: Commitment,
    pub observed_at_unix_ms: u64,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedEventEnvelope {
    pub program: PinnedProgram,
    pub event_name: Option<String>,
    pub discriminator: Option<[u8; 8]>,
    pub status: EventDecodeStatus,
    pub transport: EventTransport,
    /// Complete bytes received from the transport. For event-CPI this includes
    /// the Anchor event tag; for `Program data:` it is the decoded log value.
    pub raw_envelope: Vec<u8>,
    /// Event discriminator plus payload (the value hashed and persisted).
    pub raw_event: Vec<u8>,
    pub payload: Vec<u8>,
    pub decoded_fields: Option<Value>,
    pub decode_error: Option<String>,
    pub observation: EventObservation,
}

/// A direct mapping to `dusk_ingestion.event_observations` columns. The caller
/// converts `observed_at_unix_ms` to its database timestamp representation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonicalObservationRecord {
    pub cluster: String,
    pub program_id: String,
    pub idl_hash: String,
    pub protocol_revision: String,
    pub event_key: String,
    pub transaction_signature: String,
    pub instruction_path: Vec<u16>,
    pub event_ordinal: u16,
    pub slot: u64,
    pub blockhash: String,
    pub parent_slot: Option<u64>,
    pub commitment: Commitment,
    pub event_name: Option<String>,
    pub payload_hash: String,
    pub decoded_payload: Option<Value>,
    pub raw_event: Vec<u8>,
    pub source: String,
    pub observed_at_unix_ms: u64,
}

impl DecodedEventEnvelope {
    pub fn canonical_record(&self) -> CanonicalObservationRecord {
        let key = &self.observation.key;
        CanonicalObservationRecord {
            cluster: key.identity.cluster.clone(),
            program_id: key.identity.program_id.clone(),
            idl_hash: key.identity.idl_hash.clone(),
            protocol_revision: key.identity.protocol_revision.clone(),
            event_key: key.stable_key(),
            transaction_signature: key.transaction_signature.clone(),
            instruction_path: key.instruction_path.clone(),
            event_ordinal: key.event_ordinal,
            slot: self.observation.slot,
            blockhash: self.observation.blockhash.clone(),
            parent_slot: self.observation.parent_slot,
            commitment: self.observation.commitment,
            event_name: self.event_name.clone(),
            payload_hash: self.observation.payload_hash.clone(),
            decoded_payload: self.decoded_fields.clone(),
            raw_event: self.raw_event.clone(),
            source: self.observation.source.clone(),
            observed_at_unix_ms: self.observation.observed_at_unix_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedInstructionEnvelope {
    pub program: PinnedProgram,
    pub instruction_name: Option<String>,
    pub discriminator: Option<[u8; 8]>,
    pub status: InstructionDecodeStatus,
    pub raw_instruction: Vec<u8>,
    pub payload: Vec<u8>,
    pub decoded_arguments: Option<Value>,
    pub decode_error: Option<String>,
}

#[derive(Debug, Clone)]
struct EventDescriptor {
    name: String,
}

#[derive(Debug, Clone)]
struct InstructionDescriptor {
    name: String,
    args: Vec<Value>,
}

#[derive(Debug, Clone)]
struct AccountDescriptor {
    name: String,
    layout_scope: AccountLayoutScope,
}

#[derive(Debug, Clone)]
struct EventOccurrence {
    instruction_path: Vec<u16>,
    event_ordinal: u16,
    transport: EventTransport,
}

#[derive(Debug, Clone)]
struct ProgramRegistry {
    accounts: BTreeMap<[u8; 8], AccountDescriptor>,
    events: BTreeMap<[u8; 8], EventDescriptor>,
    instructions: BTreeMap<[u8; 8], InstructionDescriptor>,
    types: TypeRegistry,
}

impl ProgramRegistry {
    fn from_bytes(bytes: &[u8], expected_address: &str) -> Result<Self, DecoderError> {
        let idl: Value = serde_json::from_slice(bytes)
            .map_err(|error| DecoderError::InvalidIdl(error.to_string()))?;
        let address = idl
            .get("address")
            .and_then(Value::as_str)
            .ok_or_else(|| DecoderError::InvalidIdl("IDL address is missing".to_owned()))?;
        if address != expected_address {
            return Err(DecoderError::InvalidIdl(format!(
                "IDL address {address} does not match pinned address {expected_address}"
            )));
        }

        let types = TypeRegistry::from_idl(&idl).map_err(DecoderError::InvalidIdl)?;
        let mut accounts = BTreeMap::new();
        let empty_accounts = Vec::new();
        for account in idl
            .get("accounts")
            .and_then(Value::as_array)
            .unwrap_or(&empty_accounts)
        {
            let name = required_name(account, "account")?;
            if !types.contains(name) {
                return Err(DecoderError::InvalidIdl(format!(
                    "account {name} has no matching IDL type"
                )));
            }
            if !types.is_struct(name) {
                return Err(DecoderError::InvalidIdl(format!(
                    "account {name} does not reference a struct layout"
                )));
            }
            let discriminator = required_discriminator(account, "account", name)?;
            let expected = anchor_discriminator("account", name);
            if discriminator != expected {
                return Err(DecoderError::InvalidIdl(format!(
                    "account {name} discriminator does not equal sha256(account:{name})[..8]"
                )));
            }
            if accounts
                .insert(
                    discriminator,
                    AccountDescriptor {
                        name: name.to_owned(),
                        layout_scope: if expected_address == LEVERAGE_DELEGATE_PROGRAM_ID
                            && name != "LeverageOrder"
                        {
                            AccountLayoutScope::ReferencedExternalLayout
                        } else {
                            AccountLayoutScope::ExpectedProgramOwned
                        },
                    },
                )
                .is_some()
            {
                return Err(DecoderError::InvalidIdl(format!(
                    "duplicate account discriminator for {name}"
                )));
            }
        }
        let mut events = BTreeMap::new();
        let empty_events = Vec::new();
        for event in idl
            .get("events")
            .and_then(Value::as_array)
            .unwrap_or(&empty_events)
        {
            let name = required_name(event, "event")?;
            if !types.contains(name) {
                return Err(DecoderError::InvalidIdl(format!(
                    "event {name} has no matching IDL type"
                )));
            }
            let discriminator = required_discriminator(event, "event", name)?;
            let expected = anchor_discriminator("event", name);
            if discriminator != expected {
                return Err(DecoderError::InvalidIdl(format!(
                    "event {name} discriminator does not equal sha256(event:{name})[..8]"
                )));
            }
            if events
                .insert(
                    discriminator,
                    EventDescriptor {
                        name: name.to_owned(),
                    },
                )
                .is_some()
            {
                return Err(DecoderError::InvalidIdl(format!(
                    "duplicate event discriminator for {name}"
                )));
            }
        }

        let mut instructions = BTreeMap::new();
        for instruction in idl
            .get("instructions")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                DecoderError::InvalidIdl("IDL instructions array is missing".to_owned())
            })?
        {
            let name = required_name(instruction, "instruction")?;
            let discriminator = required_discriminator(instruction, "instruction", name)?;
            let expected = anchor_discriminator("global", name);
            if discriminator != expected {
                return Err(DecoderError::InvalidIdl(format!(
                    "instruction {name} discriminator does not equal sha256(global:{name})[..8]"
                )));
            }
            let args = instruction
                .get("args")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    DecoderError::InvalidIdl(format!("instruction {name} args are missing"))
                })?
                .clone();
            if instructions
                .insert(
                    discriminator,
                    InstructionDescriptor {
                        name: name.to_owned(),
                        args,
                    },
                )
                .is_some()
            {
                return Err(DecoderError::InvalidIdl(format!(
                    "duplicate instruction discriminator for {name}"
                )));
            }
        }
        Ok(Self {
            accounts,
            events,
            instructions,
            types,
        })
    }
}

/// Decoder for the exact Dusk and leverage-delegate IDLs in
/// `protocol/protocol.lock.json`.
#[derive(Debug, Clone)]
pub struct PinnedIdlDecoder {
    cluster: String,
    dusk: ProgramRegistry,
    delegate: ProgramRegistry,
    limits: DecodeLimits,
}

impl PinnedIdlDecoder {
    pub fn new(cluster: impl Into<String>) -> Result<Self, DecoderError> {
        verify_vendored_protocol()?;
        let cluster = cluster.into();
        ProtocolIdentity::vendored_dusk(cluster.clone())?;
        Ok(Self {
            cluster,
            dusk: ProgramRegistry::from_bytes(DUSK_IDL, DUSK_PROGRAM_ID)?,
            delegate: ProgramRegistry::from_bytes(
                LEVERAGE_DELEGATE_IDL,
                LEVERAGE_DELEGATE_PROGRAM_ID,
            )?,
            limits: DecodeLimits::default(),
        })
    }

    pub fn event_names(&self, program: PinnedProgram) -> Vec<&str> {
        self.registry(program)
            .events
            .values()
            .map(|event| event.name.as_str())
            .collect()
    }

    pub fn account_names(&self, program: PinnedProgram) -> Vec<&str> {
        self.registry(program)
            .accounts
            .values()
            .map(|account| account.name.as_str())
            .collect()
    }

    pub fn instruction_names(&self, program: PinnedProgram) -> Vec<&str> {
        self.registry(program)
            .instructions
            .values()
            .map(|instruction| instruction.name.as_str())
            .collect()
    }

    pub fn decode_event_cpi_instruction(
        &self,
        context: &TransactionObservationContext,
        program_id: &str,
        instruction_path: Vec<u16>,
        event_ordinal: u16,
        data: &[u8],
    ) -> Result<DecodedEventEnvelope, DecoderError> {
        if !data.starts_with(&ANCHOR_EVENT_CPI_TAG) {
            return Err(DecoderError::NotAnchorEventCpi);
        }
        let program = self.program_for_id(program_id)?;
        self.decode_raw_event(
            context,
            program,
            EventOccurrence {
                instruction_path,
                event_ordinal,
                transport: EventTransport::AnchorEventCpi,
            },
            data.to_vec(),
            &data[ANCHOR_EVENT_CPI_TAG.len()..],
        )
    }

    pub fn decode_instruction(
        &self,
        program_id: &str,
        data: &[u8],
    ) -> Result<DecodedInstructionEnvelope, DecoderError> {
        let program = self.program_for_id(program_id)?;
        if data.starts_with(&ANCHOR_EVENT_CPI_TAG) {
            return Ok(DecodedInstructionEnvelope {
                program,
                instruction_name: None,
                discriminator: data.get(8..16).and_then(slice_discriminator),
                status: InstructionDecodeStatus::AnchorEventCpi,
                raw_instruction: data.to_vec(),
                payload: data.get(8..).unwrap_or_default().to_vec(),
                decoded_arguments: None,
                decode_error: None,
            });
        }

        let Some(discriminator) = data.get(..8).and_then(slice_discriminator) else {
            return Ok(DecodedInstructionEnvelope {
                program,
                instruction_name: None,
                discriminator: None,
                status: InstructionDecodeStatus::MissingDiscriminator,
                raw_instruction: data.to_vec(),
                payload: Vec::new(),
                decoded_arguments: None,
                decode_error: None,
            });
        };
        let payload = &data[8..];
        let registry = self.registry(program);
        let Some(descriptor) = registry.instructions.get(&discriminator) else {
            return Ok(DecodedInstructionEnvelope {
                program,
                instruction_name: None,
                discriminator: Some(discriminator),
                status: InstructionDecodeStatus::UnknownDiscriminator,
                raw_instruction: data.to_vec(),
                payload: payload.to_vec(),
                decoded_arguments: None,
                decode_error: None,
            });
        };
        match registry
            .types
            .decode_fields(&descriptor.args, payload, self.limits)
        {
            Ok(arguments) => Ok(DecodedInstructionEnvelope {
                program,
                instruction_name: Some(descriptor.name.clone()),
                discriminator: Some(discriminator),
                status: InstructionDecodeStatus::Decoded,
                raw_instruction: data.to_vec(),
                payload: payload.to_vec(),
                decoded_arguments: Some(arguments),
                decode_error: None,
            }),
            Err(error) => Ok(DecodedInstructionEnvelope {
                program,
                instruction_name: Some(descriptor.name.clone()),
                discriminator: Some(discriminator),
                status: InstructionDecodeStatus::MalformedKnownArguments,
                raw_instruction: data.to_vec(),
                payload: payload.to_vec(),
                decoded_arguments: None,
                decode_error: Some(error),
            }),
        }
    }

    pub fn decode_program_data_logs(
        &self,
        context: &TransactionObservationContext,
        logs: &[String],
        outer_instruction_indices: &[u16],
    ) -> LogDecodeOutput {
        logs::decode_program_data_logs(self, context, logs, outer_instruction_indices)
    }

    fn decode_raw_event(
        &self,
        context: &TransactionObservationContext,
        program: PinnedProgram,
        occurrence: EventOccurrence,
        raw_envelope: Vec<u8>,
        raw_event: &[u8],
    ) -> Result<DecodedEventEnvelope, DecoderError> {
        let identity = match program {
            PinnedProgram::Dusk => ProtocolIdentity::vendored_dusk(self.cluster.clone())?,
            PinnedProgram::LeverageDelegate => {
                ProtocolIdentity::vendored_leverage_delegate(self.cluster.clone())?
            }
        };
        let key = CanonicalEventKey::new(
            identity,
            context.transaction_signature.clone(),
            occurrence.instruction_path,
            occurrence.event_ordinal,
        )?;
        let observation = EventObservation {
            key,
            slot: context.slot,
            blockhash: context.blockhash.clone(),
            parent_slot: context.parent_slot,
            commitment: context.commitment,
            payload_hash: sha256_hex(raw_event),
            observed_at_unix_ms: context.observed_at_unix_ms,
            source: context.source.clone(),
        };
        observation.validate()?;

        let Some(discriminator) = raw_event.get(..8).and_then(slice_discriminator) else {
            return Ok(DecodedEventEnvelope {
                program,
                event_name: None,
                discriminator: None,
                status: EventDecodeStatus::MissingDiscriminator,
                transport: occurrence.transport,
                raw_envelope,
                raw_event: raw_event.to_vec(),
                payload: Vec::new(),
                decoded_fields: None,
                decode_error: None,
                observation,
            });
        };
        let payload = &raw_event[8..];
        let registry = self.registry(program);
        let Some(descriptor) = registry.events.get(&discriminator) else {
            return Ok(DecodedEventEnvelope {
                program,
                event_name: None,
                discriminator: Some(discriminator),
                status: EventDecodeStatus::UnknownDiscriminator,
                transport: occurrence.transport,
                raw_envelope,
                raw_event: raw_event.to_vec(),
                payload: payload.to_vec(),
                decoded_fields: None,
                decode_error: None,
                observation,
            });
        };
        match registry
            .types
            .decode_named_type(&descriptor.name, payload, self.limits)
        {
            Ok(fields) => Ok(DecodedEventEnvelope {
                program,
                event_name: Some(descriptor.name.clone()),
                discriminator: Some(discriminator),
                status: EventDecodeStatus::Decoded,
                transport: occurrence.transport,
                raw_envelope,
                raw_event: raw_event.to_vec(),
                payload: payload.to_vec(),
                decoded_fields: Some(fields),
                decode_error: None,
                observation,
            }),
            Err(error) => Ok(DecodedEventEnvelope {
                program,
                event_name: Some(descriptor.name.clone()),
                discriminator: Some(discriminator),
                status: EventDecodeStatus::MalformedKnownPayload,
                transport: occurrence.transport,
                raw_envelope,
                raw_event: raw_event.to_vec(),
                payload: payload.to_vec(),
                decoded_fields: None,
                decode_error: Some(error),
                observation,
            }),
        }
    }

    fn program_for_id(&self, program_id: &str) -> Result<PinnedProgram, DecoderError> {
        match program_id {
            DUSK_PROGRAM_ID => Ok(PinnedProgram::Dusk),
            LEVERAGE_DELEGATE_PROGRAM_ID => Ok(PinnedProgram::LeverageDelegate),
            other => Err(DecoderError::UnpinnedProgram(other.to_owned())),
        }
    }

    fn registry(&self, program: PinnedProgram) -> &ProgramRegistry {
        match program {
            PinnedProgram::Dusk => &self.dusk,
            PinnedProgram::LeverageDelegate => &self.delegate,
        }
    }
}

fn required_name<'a>(value: &'a Value, label: &str) -> Result<&'a str, DecoderError> {
    value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| DecoderError::InvalidIdl(format!("IDL {label} name is missing")))
}

fn required_discriminator(value: &Value, label: &str, name: &str) -> Result<[u8; 8], DecoderError> {
    let values = value
        .get("discriminator")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DecoderError::InvalidIdl(format!("IDL {label} {name} discriminator is missing"))
        })?;
    if values.len() != 8 {
        return Err(DecoderError::InvalidIdl(format!(
            "IDL {label} {name} discriminator has {} bytes, expected 8",
            values.len()
        )));
    }
    let mut bytes = [0_u8; 8];
    for (target, value) in bytes.iter_mut().zip(values) {
        let byte = value.as_u64().filter(|value| *value <= u64::from(u8::MAX));
        *target = byte.map(|value| value as u8).ok_or_else(|| {
            DecoderError::InvalidIdl(format!(
                "IDL {label} {name} discriminator contains a non-byte"
            ))
        })?;
    }
    Ok(bytes)
}

fn anchor_discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let digest = hash(format!("{namespace}:{name}").as_bytes()).to_bytes();
    digest[..8]
        .try_into()
        .expect("SHA-256 output always contains eight bytes")
}

fn slice_discriminator(bytes: &[u8]) -> Option<[u8; 8]> {
    bytes.try_into().ok()
}

#[cfg(test)]
mod tests;
