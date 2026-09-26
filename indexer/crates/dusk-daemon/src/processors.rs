//! Streamed transactions to persisted events and orders.
//!
//! Each transaction is decoded whole with the pinned IDL — event-CPI inner
//! instructions and `Program data:` logs — so the processor re-encodes
//! Carbon's transaction into the RPC shape that decoder reads.

use {
    crate::{
        extract::{self, ObservationSource},
        orders, persist,
    },
    anyhow::{anyhow, Context as _, Result},
    async_trait::async_trait,
    carbon_core::{
        collection::InstructionDecoderCollection,
        error::CarbonResult,
        instruction::DecodedInstruction,
        metrics::MetricsCollection,
        processor::Processor,
        transaction::{TransactionMetadata, TransactionProcessorInputType},
    },
    chrono::{DateTime, TimeZone, Utc},
    dusk_indexer_foundation::{decoder::PinnedIdlDecoder, Commitment},
    solana_transaction::versioned::VersionedTransaction,
    solana_transaction_status::{
        EncodedConfirmedTransactionWithStatusMeta, UiTransactionEncoding,
        VersionedTransactionWithStatusMeta,
    },
    sqlx::PgPool,
    std::{sync::Arc, time::Duration},
};

/// Streamed updates carry no containing block. Event keys never include the
/// blockhash, so one fixed marker keeps redelivered events deduplicated.
pub const STREAM_BLOCKHASH: &str = "unavailable:helius-atlas-ws";

/// Carbon's transaction pipe needs an instruction collection. Decoding here
/// works on whole transactions, so the collection parses nothing.
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
pub enum DuskInstructions {}

impl InstructionDecoderCollection for DuskInstructions {
    type InstructionType = ();

    fn parse_instruction(
        _instruction: &solana_instruction::Instruction,
    ) -> Option<DecodedInstruction<Self>> {
        None
    }

    fn get_type(&self) -> Self::InstructionType {
        match *self {}
    }
}

pub struct DuskTransactionProcessor {
    pool: PgPool,
    decoder: Arc<PinnedIdlDecoder>,
    cluster: String,
    first_slot: u64,
}

impl DuskTransactionProcessor {
    pub fn new(
        pool: PgPool,
        decoder: Arc<PinnedIdlDecoder>,
        cluster: String,
        first_slot: u64,
    ) -> Self {
        Self {
            pool,
            decoder,
            cluster,
            first_slot,
        }
    }

    /// Re-ingest one transaction through the same path as the stream, for a
    /// transaction the stream dropped or missed while disconnected.
    pub async fn replay(&self, transaction: &TransactionMetadata) -> Result<usize> {
        self.ingest(transaction).await
    }

    async fn ingest(&self, transaction: &TransactionMetadata) -> Result<usize> {
        let signature = transaction.signature.to_string();
        let observed = extract::decode_transaction(
            &self.decoder,
            &signature,
            &encode_transaction(transaction)?,
            &ObservationSource {
                blockhash: STREAM_BLOCKHASH,
                parent_slot: None,
                block_time: transaction.block_time,
                commitment: Commitment::Confirmed,
                source: persist::STREAM_NAME,
            },
        )?;
        let time = event_time(observed.block_time, Utc::now());
        // Every write is idempotent, so a transient database error retries
        // the whole transaction.
        let mut attempt = 0;
        loop {
            match self.persist(&signature, &observed, time).await {
                Ok(()) => break,
                Err(error) if attempt < 2 => {
                    attempt += 1;
                    log::warn!("retrying {signature} after database error: {error:#}");
                    tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
                }
                Err(error) => return Err(error),
            }
        }
        log::debug!(
            "slot {}: {} event(s) [{}], {} order instruction(s)",
            observed.slot,
            observed.events.len(),
            observed.event_names().join(", "),
            observed.orders.len()
        );
        Ok(observed.events.len())
    }

    async fn persist(
        &self,
        signature: &str,
        observed: &extract::ObservedTransaction,
        time: DateTime<Utc>,
    ) -> Result<()> {
        for event in &observed.events {
            persist::persist_event(&self.pool, event, time, self.first_slot).await?;
        }
        for order in &observed.orders {
            orders::persist(
                &self.pool,
                &self.cluster,
                signature,
                observed.slot,
                STREAM_BLOCKHASH,
                time.timestamp(),
                order,
            )
            .await?;
        }
        persist::advance_cursor(
            &self.pool,
            &self.cluster,
            signature,
            observed.slot,
            self.first_slot,
        )
        .await
    }
}

#[async_trait]
impl Processor for DuskTransactionProcessor {
    type InputType = TransactionProcessorInputType<DuskInstructions>;

    async fn process(
        &mut self,
        (transaction, _, _): Self::InputType,
        metrics: Arc<MetricsCollection>,
    ) -> CarbonResult<()> {
        match self.ingest(&transaction).await {
            Ok(events) => {
                metrics
                    .increment_counter("dusk_transactions_ingested", 1)
                    .await?;
                metrics
                    .increment_counter("dusk_events_ingested", events as u64)
                    .await?;
            }
            // One transaction the decoder or database refuses must not stop
            // the stream. It is logged with its signature for replay.
            Err(error) => {
                log::error!(
                    "dropped transaction {} at slot {}: {error:#}",
                    transaction.signature,
                    transaction.slot
                );
                metrics
                    .increment_counter("dusk_transactions_dropped", 1)
                    .await?;
            }
        }
        Ok(())
    }
}

/// Block time when the source provides it, arrival time otherwise.
fn event_time(block_time: Option<i64>, arrived: DateTime<Utc>) -> DateTime<Utc> {
    block_time
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        .unwrap_or(arrived)
}

/// An RPC transaction (base64) in Carbon's form, converted as the Helius
/// datasource converts a streamed one.
pub fn metadata_from_rpc(
    fetched: &EncodedConfirmedTransactionWithStatusMeta,
) -> Result<TransactionMetadata> {
    let transaction = fetched
        .transaction
        .transaction
        .decode()
        .context("transaction is not binary-encoded")?;
    let meta = carbon_core::transformers::transaction_metadata_from_original_meta(
        fetched
            .transaction
            .meta
            .clone()
            .context("transaction has no meta")?,
    )
    .map_err(|error| anyhow!("converting transaction meta: {error:?}"))?;
    Ok(TransactionMetadata {
        slot: fetched.slot,
        signature: *transaction
            .signatures
            .first()
            .context("transaction has no signature")?,
        fee_payer: *transaction
            .message
            .static_account_keys()
            .first()
            .context("transaction has no fee payer")?,
        meta,
        message: transaction.message.clone(),
        block_time: fetched.block_time,
        block_hash: None,
    })
}

/// Carbon's decoded transaction back to the JSON RPC form the pinned decoder
/// reads. Only the first signature is kept; the decoder checks exactly that
/// one.
pub fn encode_transaction(
    transaction: &TransactionMetadata,
) -> Result<EncodedConfirmedTransactionWithStatusMeta> {
    let encoded = VersionedTransactionWithStatusMeta {
        transaction: VersionedTransaction {
            signatures: vec![transaction.signature],
            message: transaction.message.clone(),
        },
        meta: transaction.meta.clone(),
    }
    .encode(UiTransactionEncoding::Json, Some(0), false)
    .map_err(|error| anyhow!("encoding streamed transaction: {error:?}"))?;
    Ok(EncodedConfirmedTransactionWithStatusMeta {
        slot: transaction.slot,
        transaction: encoded,
        block_time: transaction.block_time,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_time_prefers_block_time_and_falls_back_to_arrival() {
        let arrived = Utc.timestamp_opt(1_790_000_000, 0).single().unwrap();
        assert_eq!(
            event_time(Some(1_789_999_990), arrived).timestamp(),
            1_789_999_990
        );
        assert_eq!(event_time(None, arrived), arrived);
    }

    /// A real devnet swap, delivered the way the Helius datasource delivers it
    /// (base64 transaction, meta converted to Carbon's types, no block), comes
    /// back out of the pinned decoder as one confirmed SwapExecuted event.
    #[test]
    fn a_streamed_devnet_swap_decodes_its_event() {
        let fixture: EncodedConfirmedTransactionWithStatusMeta =
            serde_json::from_str(include_str!("../fixtures/swap-executed-devnet.json")).unwrap();
        let streamed = TransactionMetadata {
            block_time: None,
            ..metadata_from_rpc(&fixture).unwrap()
        };
        let signature = streamed.signature.to_string();
        let decoder = PinnedIdlDecoder::new("devnet").unwrap();
        let observed = extract::decode_transaction(
            &decoder,
            &signature,
            &encode_transaction(&streamed).unwrap(),
            &ObservationSource {
                blockhash: STREAM_BLOCKHASH,
                parent_slot: None,
                block_time: streamed.block_time,
                commitment: Commitment::Confirmed,
                source: persist::STREAM_NAME,
            },
        )
        .unwrap();
        assert_eq!(observed.event_names(), vec!["SwapExecuted"]);
        assert!(observed.orders.is_empty());
        let record = observed.events[0].canonical_record();
        assert_eq!(record.commitment, Commitment::Confirmed);
        assert_eq!(record.blockhash, STREAM_BLOCKHASH);
        assert_eq!(record.slot, 504_079_196);
        assert!(record.event_key.contains(&signature));
    }
}
