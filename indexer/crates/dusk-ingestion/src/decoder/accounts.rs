use {
    super::{
        projections::build_product_projections, AccountProjections, DecoderError, PinnedIdlDecoder,
        PinnedProgram,
    },
    crate::{sha256_hex, Commitment, ProtocolIdentity},
    serde::{Deserialize, Serialize},
    serde_json::Value,
    solana_pubkey::Pubkey,
    std::str::FromStr,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountDecodeStatus {
    Decoded,
    UnknownDiscriminator,
    MissingDiscriminator,
    MalformedKnownPayload,
}

/// Anchor IDL account declarations include both program-owned state and typed
/// external CPI inputs. This scope prevents a shared discriminator from being
/// mistaken for proof of ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountLayoutScope {
    ExpectedProgramOwned,
    ReferencedExternalLayout,
}

/// RPC facts supplied alongside one account-data observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountObservationContext {
    pub account_pubkey: String,
    pub transaction_signature: Option<String>,
    pub write_version: Option<u64>,
    pub slot: u64,
    pub blockhash: String,
    pub parent_slot: Option<u64>,
    pub commitment: Commitment,
    pub observed_at_unix_ms: u64,
    pub source: String,
}

/// Protocol identity and fork/freshness facts that must travel with every
/// account projection and API response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountFreshness {
    pub identity: ProtocolIdentity,
    pub account_pubkey: String,
    pub data_hash: String,
    pub transaction_signature: Option<String>,
    pub write_version: Option<u64>,
    pub slot: u64,
    pub blockhash: String,
    pub parent_slot: Option<u64>,
    pub commitment: Commitment,
    pub observed_at_unix_ms: u64,
    pub source: String,
}

impl AccountFreshness {
    pub fn validate(&self) -> Result<(), DecoderError> {
        self.identity.validate()?;
        Pubkey::from_str(&self.account_pubkey).map_err(|error| {
            DecoderError::InvalidAccountContext(format!("invalid account pubkey: {error}"))
        })?;
        if self.blockhash.is_empty() || self.blockhash.contains('|') {
            return Err(DecoderError::InvalidAccountContext(
                "blockhash is empty or contains a delimiter".to_owned(),
            ));
        }
        if self
            .transaction_signature
            .as_ref()
            .is_some_and(|signature| {
                signature.is_empty() || signature.len() > 128 || signature.contains('|')
            })
        {
            return Err(DecoderError::InvalidAccountContext(
                "transaction signature is empty, too long, or contains a delimiter".to_owned(),
            ));
        }
        if self.data_hash.len() != 64
            || !self
                .data_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(DecoderError::InvalidAccountContext(
                "data hash is not lowercase SHA-256".to_owned(),
            ));
        }
        if self.source.is_empty() {
            return Err(DecoderError::InvalidAccountContext(
                "source must not be empty".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DecodedAccountEnvelope {
    pub program: PinnedProgram,
    pub account_name: Option<String>,
    pub layout_scope: Option<AccountLayoutScope>,
    pub discriminator: Option<[u8; 8]>,
    pub status: AccountDecodeStatus,
    pub raw_account: Vec<u8>,
    pub payload: Vec<u8>,
    pub allocation_padding_bytes: usize,
    pub decoded_fields: Option<Value>,
    pub decode_error: Option<String>,
    pub projections: AccountProjections,
    pub projection_error: Option<String>,
    pub freshness: AccountFreshness,
}

impl PinnedIdlDecoder {
    pub fn decode_account(
        &self,
        context: &AccountObservationContext,
        owner_program_id: &str,
        data: &[u8],
    ) -> Result<DecodedAccountEnvelope, DecoderError> {
        let program = self.program_for_id(owner_program_id)?;
        let identity = match program {
            PinnedProgram::Dusk => ProtocolIdentity::vendored_dusk(self.cluster.clone())?,
            PinnedProgram::LeverageDelegate => {
                ProtocolIdentity::vendored_leverage_delegate(self.cluster.clone())?
            }
        };
        let freshness = AccountFreshness {
            identity,
            account_pubkey: context.account_pubkey.clone(),
            data_hash: sha256_hex(data),
            transaction_signature: context.transaction_signature.clone(),
            write_version: context.write_version,
            slot: context.slot,
            blockhash: context.blockhash.clone(),
            parent_slot: context.parent_slot,
            commitment: context.commitment,
            observed_at_unix_ms: context.observed_at_unix_ms,
            source: context.source.clone(),
        };
        freshness.validate()?;

        let Some(discriminator) = data.get(..8).and_then(super::slice_discriminator) else {
            return Ok(DecodedAccountEnvelope {
                program,
                account_name: None,
                layout_scope: None,
                discriminator: None,
                status: AccountDecodeStatus::MissingDiscriminator,
                raw_account: data.to_vec(),
                payload: Vec::new(),
                allocation_padding_bytes: 0,
                decoded_fields: None,
                decode_error: None,
                projections: AccountProjections::default(),
                projection_error: None,
                freshness,
            });
        };
        let payload = &data[8..];
        let registry = self.registry(program);
        let Some(descriptor) = registry.accounts.get(&discriminator) else {
            return Ok(DecodedAccountEnvelope {
                program,
                account_name: None,
                layout_scope: None,
                discriminator: Some(discriminator),
                status: AccountDecodeStatus::UnknownDiscriminator,
                raw_account: data.to_vec(),
                payload: payload.to_vec(),
                allocation_padding_bytes: 0,
                decoded_fields: None,
                decode_error: None,
                projections: AccountProjections::default(),
                projection_error: None,
                freshness,
            });
        };

        match registry
            .types
            .decode_named_account_type(&descriptor.name, payload, self.limits)
        {
            Ok((fields, allocation_padding_bytes)) => {
                let (projections, projection_error) =
                    if descriptor.layout_scope == AccountLayoutScope::ReferencedExternalLayout {
                        (AccountProjections::default(), None)
                    } else {
                        match build_product_projections(
                            &descriptor.name,
                            &context.account_pubkey,
                            &fields,
                        ) {
                            Ok(projections) => (projections, None),
                            Err(error) => (AccountProjections::default(), Some(error)),
                        }
                    };
                Ok(DecodedAccountEnvelope {
                    program,
                    account_name: Some(descriptor.name.clone()),
                    layout_scope: Some(descriptor.layout_scope),
                    discriminator: Some(discriminator),
                    status: AccountDecodeStatus::Decoded,
                    raw_account: data.to_vec(),
                    payload: payload.to_vec(),
                    allocation_padding_bytes,
                    decoded_fields: Some(fields),
                    decode_error: None,
                    projections,
                    projection_error,
                    freshness,
                })
            }
            Err(error) => Ok(DecodedAccountEnvelope {
                program,
                account_name: Some(descriptor.name.clone()),
                layout_scope: Some(descriptor.layout_scope),
                discriminator: Some(discriminator),
                status: AccountDecodeStatus::MalformedKnownPayload,
                raw_account: data.to_vec(),
                payload: payload.to_vec(),
                allocation_padding_bytes: 0,
                decoded_fields: None,
                decode_error: Some(error),
                projections: AccountProjections::default(),
                projection_error: None,
                freshness,
            }),
        }
    }
}
