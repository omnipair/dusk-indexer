//! Durable delegate instructions preserve orders that were created and closed
//! between account scans.
use {
    anyhow::{bail, Context, Result},
    dusk_indexer_foundation::{
        decoder::{InstructionDecodeStatus, PinnedIdlDecoder},
        LEVERAGE_DELEGATE_IDL_SHA256, LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION,
    },
    serde_json::{json, Value},
    solana_transaction_status::UiCompiledInstruction,
    sqlx::PgPool,
};

pub struct OrderInstruction {
    pub path: Vec<u16>,
    pub name: String,
    pub order: String,
    pub owner: String,
    pub market: Option<String>,
    pub raw: Vec<u8>,
    pub accounts: Value,
    pub arguments: Value,
}

pub fn decode(
    decoder: &PinnedIdlDecoder,
    instruction: &UiCompiledInstruction,
    keys: &[String],
    path: Vec<u16>,
) -> Result<Option<OrderInstruction>> {
    let raw = bs58::decode(&instruction.data).into_vec()?;
    let decoded = decoder.decode_instruction(LEVERAGE_DELEGATE_PROGRAM_ID, &raw)?;
    if decoded.status == InstructionDecodeStatus::AnchorEventCpi {
        return Ok(None);
    }
    if decoded.status != InstructionDecodeStatus::Decoded {
        bail!(
            "delegate instruction failed pinned decoding: {:?}",
            decoded.status
        );
    }
    let name = decoded
        .instruction_name
        .context("instruction name missing")?;
    // These instructions mutate order state or its final payout. No
    // account-existence inference.
    if !matches!(
        name.as_str(),
        "create_leverage_order"
            | "update_leverage_order"
            | "cancel_leverage_order"
            | "after_close_order"
            | "create_leverage_entry_order"
            | "execute_leverage_entry_order"
            | "cancel_leverage_entry_order"
            | "create_hlp_order"
            | "execute_hlp_order"
            | "cancel_hlp_order"
            | "settle_hlp_order_yield"
    ) {
        return Ok(None);
    }
    let names = decoder.instruction_account_names(
        LEVERAGE_DELEGATE_PROGRAM_ID,
        decoded.discriminator.context("missing discriminator")?,
    )?;
    if instruction.accounts.len() < names.len() {
        bail!("delegate instruction omitted named accounts");
    }
    let all_accounts = instruction
        .accounts
        .iter()
        .map(|index| {
            keys.get(usize::from(*index))
                .cloned()
                .context("instruction account outside key space")
        })
        .collect::<Result<Vec<_>>>()?;
    let named: serde_json::Map<String, Value> = names
        .into_iter()
        .zip(all_accounts.iter().cloned().map(Value::String))
        .collect();
    let key = |role: &str| named.get(role).and_then(Value::as_str).map(str::to_owned);
    Ok(Some(OrderInstruction {
        path,
        name,
        order: key("order").context("order address missing")?,
        owner: key("owner")
            .or_else(|| key("order_owner"))
            .context("order owner missing")?,
        market: key("market"),
        raw,
        accounts: json!({"named": named, "all": all_accounts}),
        arguments: decoded
            .decoded_arguments
            .context("order arguments missing")?,
    }))
}

pub async fn persist(
    pool: &PgPool,
    cluster: &str,
    signature: &str,
    slot: u64,
    blockhash: &str,
    event_time: i64,
    instruction: &OrderInstruction,
) -> Result<String> {
    let key = format!("{cluster}|{LEVERAGE_DELEGATE_PROGRAM_ID}|{LEVERAGE_DELEGATE_IDL_SHA256}|{PROTOCOL_REVISION}|{signature}|{}", instruction.path.iter().map(u16::to_string).collect::<Vec<_>>().join("."));
    // The SQL function persists evidence first; a contradiction remains inspectable
    // and halts ingestion.
    let consistent: bool = sqlx::query_scalar("SELECT dusk_ingestion.record_order_instruction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)")
        .bind(cluster).bind(LEVERAGE_DELEGATE_PROGRAM_ID).bind(LEVERAGE_DELEGATE_IDL_SHA256).bind(PROTOCOL_REVISION)
        .bind(&key).bind(signature).bind(i64::try_from(slot)?).bind(blockhash).bind(event_time)
        .bind(instruction.path.iter().map(|v| i32::from(*v)).collect::<Vec<_>>())
        .bind(&instruction.name).bind(&instruction.order).bind(&instruction.owner).bind(&instruction.market)
        .bind(&instruction.raw).bind(serde_json::to_string(&json!({"accounts":instruction.accounts,"arguments":instruction.arguments}))?)
        .fetch_one(pool).await?;
    if !consistent {
        bail!("contradictory order instruction {key}");
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        sha2::{Digest, Sha256},
    };
    #[test]
    fn cancel_decodes_named_owner_and_order_from_the_pinned_idl() {
        let decoder = PinnedIdlDecoder::new("devnet").unwrap();
        let mut raw = Sha256::digest(b"global:cancel_leverage_order")[..8].to_vec();
        raw.extend(91u64.to_le_bytes());
        let instruction = UiCompiledInstruction {
            program_id_index: 2,
            accounts: vec![0, 1],
            data: bs58::encode(raw).into_string(),
            stack_height: Some(3),
        };
        let keys = vec![
            "order".to_owned(),
            "owner".to_owned(),
            LEVERAGE_DELEGATE_PROGRAM_ID.to_owned(),
        ];
        let decoded = decode(&decoder, &instruction, &keys, vec![2, 0, 1])
            .unwrap()
            .unwrap();
        assert_eq!(decoded.order, "order");
        assert_eq!(decoded.owner, "owner");
        assert_eq!(decoded.path, vec![2, 0, 1]);
        assert_eq!(decoded.arguments["_args"]["order_id"], "91");
    }
}
