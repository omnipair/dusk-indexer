//! Transaction → decoded event envelopes, through the pinned IDL decoder.

use {
    anyhow::{bail, Context as _, Result},
    dusk_indexer_foundation::{
        decoder::{
            DecodedEventEnvelope, EventDecodeStatus, PinnedIdlDecoder,
            TransactionObservationContext,
        },
        Commitment,
        DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_PROGRAM_ID,
    },
    solana_transaction_status::{
        EncodedConfirmedTransactionWithStatusMeta, EncodedTransaction, UiInstruction, UiMessage,
        option_serializer::OptionSerializer,
    },
};

pub struct ObservedTransaction {
    pub slot: u64,
    pub block_time: Option<i64>,
    pub events: Vec<DecodedEventEnvelope>,
}

impl ObservedTransaction {
    pub fn event_names(&self) -> Vec<String> {
        self.events
            .iter()
            .map(|event| {
                event
                    .event_name
                    .clone()
                    .unwrap_or_else(|| "<unknown>".to_owned())
            })
            .collect()
    }
}

/// Decode every Dusk/delegate event a finalized transaction carries.
///
/// Both transports are walked: Anchor event-CPI (an inner instruction whose
/// program is the pinned one and whose data opens with the event tag) and
/// `Program data:` logs. The same emission can never appear on both — the
/// program uses one transport per event — but decoding both keeps this daemon
/// correct if that ever changes, since event keys deduplicate downstream.
pub fn decode_transaction(
    decoder: &PinnedIdlDecoder,
    signature: &str,
    transaction: &EncodedConfirmedTransactionWithStatusMeta,
) -> Result<ObservedTransaction> {
    let slot = transaction.slot;
    let block_time = transaction.block_time;
    let meta = transaction
        .transaction
        .meta
        .as_ref()
        .context("transaction has no meta")?;

    let EncodedTransaction::Json(ui_transaction) = &transaction.transaction.transaction else {
        bail!("expected JSON-encoded transaction");
    };
    let UiMessage::Raw(message) = &ui_transaction.message else {
        bail!("expected raw (non-parsed) transaction message");
    };

    // The full key space: static keys, then the lookup-table loads in the
    // order the runtime appends them (writable before readonly).
    let mut account_keys: Vec<String> = message.account_keys.clone();
    if let OptionSerializer::Some(loaded) = &meta.loaded_addresses {
        account_keys.extend(loaded.writable.iter().cloned());
        account_keys.extend(loaded.readonly.iter().cloned());
    }

    let context = TransactionObservationContext {
        transaction_signature: signature.to_owned(),
        slot,
        blockhash: message.recent_blockhash.clone(),
        parent_slot: None,
        commitment: Commitment::Finalized,
        observed_at_unix_ms: now_unix_ms(),
        source: "rpc-signature-poll".to_owned(),
    };

    let mut events = Vec::new();

    // Event-CPI: inner instructions owned by a pinned program.
    if let OptionSerializer::Some(inner_sets) = &meta.inner_instructions {
        for inner_set in inner_sets {
            let outer_index = u16::from(inner_set.index);
            for (inner_position, instruction) in inner_set.instructions.iter().enumerate() {
                let UiInstruction::Compiled(compiled) = instruction else {
                    continue;
                };
                let Some(program_id) = account_keys.get(compiled.program_id_index as usize)
                else {
                    bail!("instruction references an account index outside the key space");
                };
                if program_id != DUSK_PROGRAM_ID && program_id != LEVERAGE_DELEGATE_PROGRAM_ID {
                    continue;
                }
                let data = bs58::decode(&compiled.data)
                    .into_vec()
                    .context("inner instruction data is not base58")?;
                match decoder.decode_event_cpi_instruction(
                    &context,
                    program_id,
                    vec![outer_index, inner_position as u16],
                    0,
                    &data,
                ) {
                    Ok(event) => events.push(event),
                    // A pinned program's inner instruction that is not an
                    // event emission (a real nested call) is expected.
                    Err(error) if error.to_string().contains("event tag") => {}
                    Err(error) => {
                        log::warn!("event-CPI decode failed in {signature}: {error}");
                    }
                }
            }
        }
    }

    // `Program data:` logs. Top-level invokes map 1:1 to message instructions.
    if let OptionSerializer::Some(logs) = &meta.log_messages {
        let outer_indices: Vec<u16> =
            (0..message.instructions.len() as u16).collect();
        let output = decoder.decode_program_data_logs(&context, logs, &outer_indices);
        for diagnostic in &output.diagnostics {
            log::debug!(
                "log decode diagnostic in {signature}: {:?} {}",
                diagnostic.kind,
                diagnostic.message,
            );
        }
        events.extend(output.events);
    }

    for event in &events {
        if event.status != EventDecodeStatus::Decoded {
            log::warn!(
                "event in {signature} did not decode cleanly: status={:?} error={:?}",
                event.status,
                event.decode_error,
            );
        }
    }

    Ok(ObservedTransaction {
        slot,
        block_time,
        events,
    })
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
