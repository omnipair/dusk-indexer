//! Transaction → decoded event envelopes, through the pinned IDL decoder.

use {
    anyhow::{bail, Context as _, Result},
    dusk_indexer_foundation::{
        decoder::{
            DecodedEventEnvelope, EventDecodeStatus, PinnedIdlDecoder,
            TransactionObservationContext,
        },
        Commitment, DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_PROGRAM_ID,
    },
    solana_transaction_status::{
        option_serializer::OptionSerializer, EncodedConfirmedTransactionWithStatusMeta,
        EncodedTransaction, UiInstruction, UiMessage,
    },
};

pub struct ObservedTransaction {
    pub slot: u64,
    pub block_time: Option<i64>,
    pub events: Vec<DecodedEventEnvelope>,
    pub orders: Vec<crate::orders::OrderInstruction>,
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
    containing_blockhash: &str,
    parent_slot: u64,
    containing_block_time: Option<i64>,
) -> Result<ObservedTransaction> {
    let slot = transaction.slot;
    if transaction.block_time.is_some()
        && containing_block_time.is_some()
        && transaction.block_time != containing_block_time
    {
        bail!("FINALIZED_INVARIANT: transaction and block times differ");
    }
    let block_time = transaction.block_time.or(containing_block_time);
    let meta = transaction
        .transaction
        .meta
        .as_ref()
        .context("transaction has no meta")?;

    if meta.err.is_some() {
        bail!("refusing event projection from a failed transaction");
    }
    require_complete_transports(&meta.inner_instructions, &meta.log_messages)?;

    let EncodedTransaction::Json(ui_transaction) = &transaction.transaction.transaction else {
        bail!("expected JSON-encoded transaction");
    };
    if ui_transaction.signatures.first().map(String::as_str) != Some(signature) {
        bail!("FINALIZED_INVARIANT: RPC transaction signature mismatch");
    }
    let UiMessage::Raw(message) = &ui_transaction.message else {
        bail!("expected raw (non-parsed) transaction message");
    };
    if message
        .address_table_lookups
        .as_ref()
        .is_some_and(|tables| !tables.is_empty())
        && !matches!(meta.loaded_addresses, OptionSerializer::Some(_))
    {
        bail!("loaded account addresses missing for versioned transaction");
    }

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
        blockhash: containing_blockhash.to_owned(),
        parent_slot: Some(parent_slot),
        commitment: Commitment::Finalized,
        observed_at_unix_ms: now_unix_ms(),
        source: "rpc-signature-poll".to_owned(),
    };

    let mut events = Vec::new();
    let mut orders = Vec::new();
    let programs = message
        .instructions
        .iter()
        .map(|instruction| {
            account_keys
                .get(instruction.program_id_index as usize)
                .map(String::as_str)
                .context("invalid outer instruction program index")
        })
        .collect::<Result<Vec<_>>>()?;
    let OptionSerializer::Some(logs) = &meta.log_messages else {
        bail!("missing invocation logs");
    };
    let outer_indices = root_instruction_indices(logs, &programs)?;
    let outcomes = invocation_outcomes(logs, &outer_indices)?;
    for (index, instruction) in message.instructions.iter().enumerate() {
        let program = account_keys
            .get(instruction.program_id_index as usize)
            .context("invalid instruction program index")?;
        if program == LEVERAGE_DELEGATE_PROGRAM_ID
            && committed_invocation(&outcomes, &[u16::try_from(index)?], program)?
        {
            if let Some(order) = crate::orders::decode(
                decoder,
                instruction,
                &account_keys,
                vec![u16::try_from(index)?],
            )? {
                orders.push(order);
            }
        }
    }

    // Event-CPI: inner instructions owned by a pinned program.
    if let OptionSerializer::Some(inner_sets) = &meta.inner_instructions {
        for inner_set in inner_sets {
            let outer_index = u16::from(inner_set.index);
            let mut paths = CpiPaths::new(outer_index);
            for instruction in &inner_set.instructions {
                let UiInstruction::Compiled(compiled) = instruction else {
                    bail!("unparsed CPI required for complete instruction identity");
                };
                let path = paths.next(compiled.stack_height.context(
                    "CPI stack height missing; complete event identity cannot be recovered",
                )?)?;
                let Some(program_id) = account_keys.get(compiled.program_id_index as usize) else {
                    bail!("instruction references an account index outside the key space");
                };
                if program_id != DUSK_PROGRAM_ID && program_id != LEVERAGE_DELEGATE_PROGRAM_ID {
                    continue;
                }
                let data = bs58::decode(&compiled.data)
                    .into_vec()
                    .context("inner instruction data is not base58")?;
                if program_id == LEVERAGE_DELEGATE_PROGRAM_ID
                    && committed_invocation(&outcomes, &path, program_id)?
                {
                    if let Some(order) =
                        crate::orders::decode(decoder, compiled, &account_keys, path.clone())?
                    {
                        orders.push(order);
                    }
                }
                match decoder.decode_event_cpi_instruction(&context, program_id, path, 0, &data) {
                    Ok(event) => events.push(event),
                    // A pinned program's inner instruction that is not an
                    // event emission (a real nested call) is expected.
                    Err(error) if error.to_string().contains("event tag") => {}
                    Err(error) => {
                        bail!("event-CPI decode failed in {signature}: {error}");
                    }
                }
            }
        }
    }

    // `Program data:` logs. Top-level invokes map 1:1 to message instructions.
    if let OptionSerializer::Some(logs) = &meta.log_messages {
        // Compute-budget/precompile instructions may emit no invocation logs.
        // Match each root invocation to the ordered message program ids instead
        // of treating the nth log root as the nth transaction instruction.
        let programs: Vec<&str> = message
            .instructions
            .iter()
            .map(|instruction| {
                account_keys
                    .get(instruction.program_id_index as usize)
                    .map(String::as_str)
                    .context("invalid outer instruction program index")
            })
            .collect::<Result<_>>()?;
        let outer_indices = root_instruction_indices(logs, &programs)?;
        let mut required_roots: Vec<u16> = programs
            .iter()
            .enumerate()
            .filter(|(_, program)| {
                **program == DUSK_PROGRAM_ID || **program == LEVERAGE_DELEGATE_PROGRAM_ID
            })
            .map(|(index, _)| u16::try_from(index))
            .collect::<std::result::Result<_, _>>()?;
        if let OptionSerializer::Some(inner_sets) = &meta.inner_instructions {
            for set in inner_sets {
                if set
                    .instructions
                    .iter()
                    .any(|instruction| match instruction {
                        UiInstruction::Compiled(ix) => account_keys
                            .get(ix.program_id_index as usize)
                            .is_some_and(|program| {
                                program == DUSK_PROGRAM_ID
                                    || program == LEVERAGE_DELEGATE_PROGRAM_ID
                            }),
                        _ => false,
                    })
                {
                    required_roots.push(u16::from(set.index));
                }
            }
        }
        require_logged_roots(&required_roots, &outer_indices)?;
        let output = decoder.decode_program_data_logs(&context, logs, &outer_indices);
        if !output.diagnostics.is_empty() {
            bail!(
                "incomplete log provenance in {signature}: {:?}",
                output.diagnostics
            );
        }
        events.extend(output.events);
    }

    for event in &events {
        if event.status != EventDecodeStatus::Decoded {
            bail!(
                "event in {signature} did not decode cleanly: status={:?} error={:?}",
                event.status,
                event.decode_error
            );
        }
    }

    Ok(ObservedTransaction {
        slot,
        block_time,
        events,
        orders,
    })
}

fn require_complete_transports<T>(
    inner: &OptionSerializer<T>,
    logs: &OptionSerializer<Vec<String>>,
) -> Result<()> {
    if !matches!(inner, OptionSerializer::Some(_)) {
        bail!("inner instruction recording unavailable; history coverage cannot advance");
    }
    let OptionSerializer::Some(logs) = logs else {
        bail!("log recording unavailable; history coverage cannot advance");
    };
    if logs.iter().any(|line| line == "Log truncated") {
        bail!("transaction logs truncated; history coverage cannot advance");
    }
    Ok(())
}

fn require_logged_roots(required: &[u16], recorded: &[u16]) -> Result<()> {
    if required.iter().any(|index| !recorded.contains(index)) {
        bail!("Dusk invocation is missing from transaction logs; history coverage cannot advance");
    }
    Ok(())
}

fn root_instruction_indices(logs: &[String], programs: &[&str]) -> Result<Vec<u16>> {
    let mut next = 0;
    let mut indices = Vec::new();
    for line in logs {
        let Some(program) = line
            .strip_prefix("Program ")
            .and_then(|line| line.strip_suffix(" invoke [1]"))
        else {
            continue;
        };
        let position = programs[next..]
            .iter()
            .position(|candidate| *candidate == program)
            .context("root invocation does not match a message instruction")?
            + next;
        indices.push(u16::try_from(position)?);
        next = position + 1;
    }
    Ok(indices)
}

/// Sibling counters belong to the parent invocation, not the flat CPI list.
struct CpiPaths {
    stack: Vec<(Vec<u16>, u16)>,
}
impl CpiPaths {
    fn new(outer: u16) -> Self {
        Self {
            stack: vec![(vec![outer], 0)],
        }
    }
    fn next(&mut self, height: u32) -> Result<Vec<u16>> {
        let depth = usize::try_from(height)?;
        if depth < 2 || depth > self.stack.len() + 1 {
            bail!("invalid CPI stack height {height}");
        }
        self.stack.truncate(depth - 1);
        let (parent, child) = self.stack.last_mut().context("missing CPI parent")?;
        let mut path = parent.clone();
        path.push(*child);
        *child = child
            .checked_add(1)
            .context("CPI sibling count exceeds u16")?;
        self.stack.push((path.clone(), 0));
        Ok(path)
    }
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

type InvocationOutcomes = std::collections::BTreeMap<Vec<u16>, (String, bool)>;
fn invocation_outcomes(logs: &[String], roots: &[u16]) -> Result<InvocationOutcomes> {
    let mut stack: Vec<(String, Vec<u16>, u16)> = Vec::new();
    let mut root = 0;
    let mut outcomes = InvocationOutcomes::new();
    for line in logs {
        let Some(line) = line.strip_prefix("Program ") else {
            continue;
        };
        if let Some((program, height)) = line.split_once(" invoke [") {
            if program.contains(' ') {
                continue;
            }
            let height: usize = height
                .strip_suffix(']')
                .context("invalid invocation depth")?
                .parse()?;
            if height != stack.len() + 1 {
                bail!("incomplete invocation stack");
            }
            let path = if let Some((_, parent, child)) = stack.last_mut() {
                let mut path = parent.clone();
                path.push(*child);
                *child = child.checked_add(1).context("too many CPI children")?;
                path
            } else {
                let index = *roots.get(root).context("missing root invocation")?;
                root += 1;
                vec![index]
            };
            stack.push((program.to_owned(), path, 0));
        } else if let Some((program, success)) = line
            .strip_suffix(" success")
            .map(|program| (program, true))
            .or_else(|| {
                line.split_once(" failed:")
                    .map(|(program, _)| (program, false))
            })
        {
            if program.contains(' ') {
                continue;
            }
            let (expected, path, _) = stack.pop().context("unbalanced invocation completion")?;
            if expected != program {
                bail!("invocation completion program mismatch");
            }
            outcomes.insert(path, (expected, success));
        }
    }
    if !stack.is_empty() || root != roots.len() {
        bail!("incomplete invocation recording");
    }
    Ok(outcomes)
}
fn committed_invocation(
    outcomes: &InvocationOutcomes,
    path: &[u16],
    program: &str,
) -> Result<bool> {
    let (observed, _) = outcomes
        .get(path)
        .context("instruction invocation missing from logs")?;
    if observed != program {
        bail!("instruction path differs from its invocation log");
    }
    for length in 1..=path.len() {
        if !outcomes
            .get(&path[..length])
            .context("missing instruction ancestor")?
            .1
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caught_cpi_failure_does_not_become_a_completed_order() {
        let logs = [
            "Program root invoke [1]",
            "Program parent invoke [2]",
            "Program delegate invoke [3]",
            "Program delegate success",
            "Program parent failed: custom program error",
            "Program delegate invoke [2]",
            "Program delegate success",
            "Program root success",
        ]
        .map(str::to_owned);
        let outcomes = invocation_outcomes(&logs, &[2]).unwrap();
        assert!(!committed_invocation(&outcomes, &[2, 0, 0], "delegate").unwrap());
        assert!(committed_invocation(&outcomes, &[2, 1], "delegate").unwrap());
        assert!(committed_invocation(&outcomes, &[2, 1], "wrong").is_err());
    }
    #[test]
    fn absent_or_truncated_recording_does_not_become_zero_events() {
        let empty = OptionSerializer::Some(Vec::<String>::new());
        assert!(require_complete_transports(&empty, &empty).is_ok());
        assert!(
            require_complete_transports(&OptionSerializer::<Vec<String>>::None, &empty).is_err()
        );
        assert!(
            require_complete_transports(&OptionSerializer::<Vec<String>>::Skip, &empty).is_err()
        );
        assert!(require_complete_transports(&empty, &OptionSerializer::None).is_err());
        assert!(require_complete_transports(&empty, &OptionSerializer::Skip).is_err());
        assert!(require_complete_transports(
            &empty,
            &OptionSerializer::Some(vec!["Log truncated".to_owned()])
        )
        .is_err());
        assert!(require_logged_roots(&[1, 3], &[1, 3]).is_ok());
        assert!(require_logged_roots(&[1, 3], &[1]).is_err());
        assert!(require_logged_roots(&[1], &[]).is_err());
    }
    #[test]
    fn root_paths_skip_instructions_that_emit_no_logs() {
        let logs = vec![
            "Program dusk invoke [1]".to_owned(),
            "Program token invoke [2]".to_owned(),
            "Program dusk success".to_owned(),
            "Program dusk invoke [1]".to_owned(),
        ];
        assert_eq!(
            root_instruction_indices(&logs, &["budget", "dusk", "dusk"]).unwrap(),
            vec![1, 2]
        );
    }
    #[test]
    fn nested_cpi_paths_include_each_parent_and_sibling() {
        let mut paths = CpiPaths::new(3);
        assert_eq!(paths.next(2).unwrap(), vec![3, 0]);
        assert_eq!(paths.next(3).unwrap(), vec![3, 0, 0]);
        assert_eq!(paths.next(3).unwrap(), vec![3, 0, 1]);
        assert_eq!(paths.next(2).unwrap(), vec![3, 1]);
        assert_eq!(paths.next(3).unwrap(), vec![3, 1, 0]);
        assert!(paths.next(5).is_err());
    }
}
