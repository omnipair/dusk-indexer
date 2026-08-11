use {
    super::*,
    base64::{engine::general_purpose::STANDARD, Engine},
    serde_json::{json, Value},
    solana_pubkey::Pubkey,
    std::collections::BTreeSet,
};

const DUSK_EVENTS: [&str; 35] = [
    "BorrowPositionLiquidated",
    "HlpClosed",
    "HlpOpened",
    "LeverageDelegationUpdated",
    "LeveragePositionClosed",
    "LeveragePositionLiquidated",
    "LeveragePositionOpened",
    "LeveragePositionUpdated",
    "LiquidityAdded",
    "LiquidityRemoved",
    "MarketCollateralDeposited",
    "MarketCollateralWithdrawn",
    "MarketCreated",
    "MarketDebtUpdated",
    "MarketHealthUpdated",
    "MarketReduceOnlyUpdated",
    "ParameterProposalCreated",
    "ParameterProposalExecuted",
    "ParameterProposalQueued",
    "ParameterProposalSupportWithdrawn",
    "ParameterProposalSupported",
    "ProtocolAuctionConfigUpdated",
    "ProtocolAuctionRecipientsUpdated",
    "ProtocolAuctionRouteUpdated",
    "ProtocolAuctionSettled",
    "ProtocolAuctionSplitUpdated",
    "ReferralBound",
    "ReferralInterestAccrued",
    "ReferralInterestClaimed",
    "ReferralInterestShareCapUpdated",
    "ReferralPartnerConfigured",
    "ReferralRecipientUpdated",
    "SwapExecuted",
    "YieldClaimed",
    "YieldRecipientUpdated",
];

const DELEGATE_INSTRUCTIONS: [&str; 6] = [
    "after_close_order",
    "before_stop_loss",
    "before_take_profit",
    "cancel_leverage_order",
    "create_leverage_order",
    "update_leverage_order",
];

const DUSK_ACCOUNTS: [&str; 10] = [
    "BorrowPosition",
    "FutarchyAuthority",
    "LeverageDelegation",
    "LeveragePosition",
    "Market",
    "ParameterProposal",
    "ProposalSupport",
    "ReferralAccrual",
    "ReferralPartner",
    "YieldAccount",
];

const DELEGATE_ACCOUNTS: [&str; 4] = [
    "LeverageDelegation",
    "LeverageOrder",
    "LeveragePosition",
    "Market",
];

fn decoder() -> PinnedIdlDecoder {
    PinnedIdlDecoder::new("surfpool-mainnet-fork").unwrap()
}

fn context() -> TransactionObservationContext {
    TransactionObservationContext {
        transaction_signature: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQhP4uG7XK5uY".to_owned(),
        slot: 42,
        blockhash: "9xQeWvG816bUx9EPfEZ8hYTTwYHHQ7QgjbLm9bRfL3J".to_owned(),
        parent_slot: Some(41),
        commitment: Commitment::Confirmed,
        observed_at_unix_ms: 1_754_953_200_000,
        source: "fixture".to_owned(),
    }
}

fn account_context() -> AccountObservationContext {
    AccountObservationContext {
        account_pubkey: Pubkey::new_from_array([9; 32]).to_string(),
        transaction_signature: Some("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQhP4uG7XK5uY".to_owned()),
        write_version: Some(3),
        slot: 43,
        blockhash: "9xQeWvG816bUx9EPfEZ8hYTTwYHHQ7QgjbLm9bRfL3J".to_owned(),
        parent_slot: Some(42),
        commitment: Commitment::Confirmed,
        observed_at_unix_ms: 1_754_953_200_001,
        source: "account-fixture".to_owned(),
    }
}

fn zero_named_type(registry: &TypeRegistry, name: &str) -> Vec<u8> {
    let mut output = Vec::new();
    let definition = registry.definition(name).unwrap();
    zero_type_definition(registry, definition.get("type").unwrap(), &mut output, 0);
    output
}

fn zero_fields(registry: &TypeRegistry, fields: &[Value]) -> Vec<u8> {
    let mut output = Vec::new();
    for field in fields {
        let field_type = field.get("type").unwrap_or(field);
        zero_type(registry, field_type, &mut output, 0);
    }
    output
}

fn zero_type_definition(
    registry: &TypeRegistry,
    definition: &Value,
    output: &mut Vec<u8>,
    depth: usize,
) {
    assert!(depth < 64, "recursive zero-value fixture");
    match definition.get("kind").and_then(Value::as_str).unwrap() {
        "struct" => {
            for field in definition.get("fields").and_then(Value::as_array).unwrap() {
                zero_type(
                    registry,
                    field.get("type").unwrap_or(field),
                    output,
                    depth + 1,
                );
            }
        }
        "enum" => {
            output.push(0);
            if let Some(fields) = definition
                .get("variants")
                .and_then(Value::as_array)
                .and_then(|variants| variants.first())
                .and_then(|variant| variant.get("fields"))
                .and_then(Value::as_array)
            {
                for field in fields {
                    zero_type(
                        registry,
                        field.get("type").unwrap_or(field),
                        output,
                        depth + 1,
                    );
                }
            }
        }
        kind => panic!("unsupported fixture type definition {kind}"),
    }
}

fn zero_type(registry: &TypeRegistry, field_type: &Value, output: &mut Vec<u8>, depth: usize) {
    assert!(depth < 64, "recursive zero-value fixture");
    if let Some(primitive) = field_type.as_str() {
        let width = match primitive {
            "bool" | "u8" | "i8" => 1,
            "u16" | "i16" => 2,
            "u32" | "i32" | "f32" => 4,
            "u64" | "i64" | "f64" => 8,
            "u128" | "i128" => 16,
            "pubkey" => 32,
            "string" | "bytes" => 4,
            other => panic!("unsupported fixture primitive {other}"),
        };
        output.resize(output.len() + width, 0);
        return;
    }
    let object = field_type.as_object().unwrap();
    if let Some(defined) = object.get("defined") {
        let name = defined
            .as_str()
            .or_else(|| defined.get("name").and_then(Value::as_str))
            .unwrap();
        let definition = registry.definition(name).unwrap();
        zero_type_definition(registry, definition.get("type").unwrap(), output, depth + 1);
    } else if object.contains_key("option") || object.contains_key("vec") {
        output
            .extend_from_slice(&[0, 0, 0, 0][..if object.contains_key("option") { 1 } else { 4 }]);
    } else if let Some(array) = object.get("array").and_then(Value::as_array) {
        let length = usize::try_from(array[1].as_u64().unwrap()).unwrap();
        for _ in 0..length {
            zero_type(registry, &array[0], output, depth + 1);
        }
    } else {
        panic!("unsupported fixture type {field_type}");
    }
}

fn event_data(decoder: &PinnedIdlDecoder, name: &str) -> Vec<u8> {
    let registry = decoder.registry(PinnedProgram::Dusk);
    let (discriminator, descriptor) = registry
        .events
        .iter()
        .find(|(_, descriptor)| descriptor.name == name)
        .unwrap();
    let mut data = ANCHOR_EVENT_CPI_TAG.to_vec();
    data.extend_from_slice(discriminator);
    data.extend_from_slice(&zero_named_type(&registry.types, &descriptor.name));
    data
}

fn account_data(decoder: &PinnedIdlDecoder, program: PinnedProgram, name: &str) -> Vec<u8> {
    let registry = decoder.registry(program);
    let (discriminator, descriptor) = registry
        .accounts
        .iter()
        .find(|(_, descriptor)| descriptor.name == name)
        .unwrap();
    let mut data = discriminator.to_vec();
    data.extend_from_slice(&zero_named_type(&registry.types, &descriptor.name));
    data
}

#[test]
fn registry_classifies_every_pinned_event_and_instruction() {
    let decoder = decoder();
    let actual_events: BTreeSet<_> = decoder
        .event_names(PinnedProgram::Dusk)
        .into_iter()
        .collect();
    let expected_events: BTreeSet<_> = DUSK_EVENTS.into_iter().collect();
    assert_eq!(actual_events, expected_events);
    assert!(decoder
        .event_names(PinnedProgram::LeverageDelegate)
        .is_empty());
    assert_eq!(decoder.instruction_names(PinnedProgram::Dusk).len(), 53);
    let actual_delegate: BTreeSet<_> = decoder
        .instruction_names(PinnedProgram::LeverageDelegate)
        .into_iter()
        .collect();
    assert_eq!(actual_delegate, DELEGATE_INSTRUCTIONS.into_iter().collect());
}

#[test]
fn anchor_tags_and_every_idl_discriminator_are_cryptographically_verified() {
    let mut anchor_event_digest = anchor_discriminator("anchor", "event");
    anchor_event_digest.reverse();
    assert_eq!(anchor_event_digest, ANCHOR_EVENT_CPI_TAG);
    let decoder = decoder();
    assert_eq!(decoder.dusk.events.len(), 35);
    assert_eq!(decoder.dusk.instructions.len(), 53);
    assert_eq!(decoder.delegate.events.len(), 0);
    assert_eq!(decoder.delegate.instructions.len(), 6);

    let mut idl: Value = serde_json::from_slice(DUSK_IDL).unwrap();
    idl["events"][0]["discriminator"][0] = json!(0);
    let tampered = serde_json::to_vec(&idl).unwrap();
    assert!(matches!(
        ProgramRegistry::from_bytes(&tampered, DUSK_PROGRAM_ID),
        Err(DecoderError::InvalidIdl(message)) if message.contains("discriminator")
    ));
}

#[test]
fn all_35_dusk_events_fully_decode_from_deterministic_borsh_fixtures() {
    let decoder = decoder();
    for (ordinal, name) in DUSK_EVENTS.iter().enumerate() {
        let data = event_data(&decoder, name);
        let decoded = decoder
            .decode_event_cpi_instruction(
                &context(),
                DUSK_PROGRAM_ID,
                vec![3, u16::try_from(ordinal).unwrap()],
                0,
                &data,
            )
            .unwrap();
        assert_eq!(decoded.event_name.as_deref(), Some(*name));
        assert_eq!(decoded.status, EventDecodeStatus::Decoded, "{name}");
        assert!(decoded.decoded_fields.is_some(), "{name}");
        assert_eq!(decoded.raw_envelope, data, "{name}");
        assert_eq!(decoded.raw_event, decoded.raw_envelope[8..], "{name}");
        decoded.observation.validate().unwrap();
        let record = decoded.canonical_record();
        assert_eq!(record.event_name.as_deref(), Some(*name));
        assert_eq!(record.raw_event, decoded.raw_event);
        assert_eq!(record.event_key, decoded.observation.key.stable_key());
    }
}

#[test]
fn all_59_pinned_instructions_fully_decode_from_deterministic_borsh_fixtures() {
    let decoder = decoder();
    for program in [PinnedProgram::Dusk, PinnedProgram::LeverageDelegate] {
        let registry = decoder.registry(program);
        for (discriminator, descriptor) in &registry.instructions {
            let mut data = discriminator.to_vec();
            data.extend_from_slice(&zero_fields(&registry.types, &descriptor.args));
            let decoded = decoder
                .decode_instruction(program.program_id(), &data)
                .unwrap();
            assert_eq!(
                decoded.status,
                InstructionDecodeStatus::Decoded,
                "{}",
                descriptor.name
            );
            assert_eq!(
                decoded.instruction_name.as_deref(),
                Some(descriptor.name.as_str())
            );
            assert!(decoded.decoded_arguments.is_some());
            assert_eq!(decoded.raw_instruction, data);
        }
    }
}

#[test]
fn nonzero_event_fields_decode_with_lossless_integer_and_pubkey_representation() {
    let decoder = decoder();
    let registry = decoder.registry(PinnedProgram::Dusk);
    let (discriminator, _) = registry
        .events
        .iter()
        .find(|(_, descriptor)| descriptor.name == "ParameterProposalExecuted")
        .unwrap();
    let proposal = Pubkey::new_from_array([1; 32]);
    let market = Pubkey::new_from_array([2; 32]);
    let mut data = ANCHOR_EVENT_CPI_TAG.to_vec();
    data.extend_from_slice(discriminator);
    data.extend_from_slice(proposal.as_ref());
    data.extend_from_slice(market.as_ref());
    data.push(4);
    data.extend_from_slice(&99_u64.to_le_bytes());
    data.extend_from_slice(&(-7_i64).to_le_bytes());
    let decoded = decoder
        .decode_event_cpi_instruction(&context(), DUSK_PROGRAM_ID, vec![1, 0], 0, &data)
        .unwrap();
    assert_eq!(
        decoded.decoded_fields,
        Some(json!({
            "proposal": proposal.to_string(),
            "market": market.to_string(),
            "family": "4",
            "new_family_revision": "99",
            "executed_at": "-7"
        }))
    );
}

#[test]
fn event_cpi_unknown_missing_and_malformed_envelopes_remain_persistable() {
    let decoder = decoder();
    let mut unknown = ANCHOR_EVENT_CPI_TAG.to_vec();
    unknown.extend_from_slice(&[255; 8]);
    unknown.extend_from_slice(&[7, 8, 9]);
    let decoded = decoder
        .decode_event_cpi_instruction(&context(), DUSK_PROGRAM_ID, vec![2, 0], 0, &unknown)
        .unwrap();
    assert_eq!(decoded.status, EventDecodeStatus::UnknownDiscriminator);
    assert_eq!(decoded.raw_event, &unknown[8..]);
    assert_eq!(decoded.canonical_record().raw_event, &unknown[8..]);

    let missing = decoder
        .decode_event_cpi_instruction(
            &context(),
            DUSK_PROGRAM_ID,
            vec![2, 1],
            0,
            &ANCHOR_EVENT_CPI_TAG,
        )
        .unwrap();
    assert_eq!(missing.status, EventDecodeStatus::MissingDiscriminator);
    assert!(missing.raw_event.is_empty());

    let mut malformed = ANCHOR_EVENT_CPI_TAG.to_vec();
    malformed.extend_from_slice(&event_data(&decoder, "MarketCreated")[8..16]);
    let decoded = decoder
        .decode_event_cpi_instruction(&context(), DUSK_PROGRAM_ID, vec![2, 2], 0, &malformed)
        .unwrap();
    assert_eq!(decoded.status, EventDecodeStatus::MalformedKnownPayload);
    assert!(decoded
        .decode_error
        .as_deref()
        .unwrap()
        .contains("truncated"));
    assert_eq!(decoded.raw_envelope, malformed);
}

#[test]
fn trailing_known_payload_bytes_are_rejected_without_losing_raw_data() {
    let decoder = decoder();
    let mut data = event_data(&decoder, "YieldRecipientUpdated");
    data.push(99);
    let decoded = decoder
        .decode_event_cpi_instruction(&context(), DUSK_PROGRAM_ID, vec![7, 0], 0, &data)
        .unwrap();
    assert_eq!(decoded.status, EventDecodeStatus::MalformedKnownPayload);
    assert!(decoded
        .decode_error
        .as_deref()
        .unwrap()
        .contains("trailing bytes"));
    assert_eq!(decoded.raw_envelope, data);
}

#[test]
fn program_data_logs_track_exact_supplied_outer_and_nested_paths() {
    let decoder = decoder();
    let encoded = STANDARD.encode(&event_data(&decoder, "SwapExecuted")[8..]);
    let logs = vec![
        format!("Program {DUSK_PROGRAM_ID} invoke [1]"),
        format!("Program {DUSK_PROGRAM_ID} invoke [2]"),
        format!("Program data: {encoded}"),
        format!("Program {DUSK_PROGRAM_ID} success"),
        format!("Program {DUSK_PROGRAM_ID} success"),
    ];
    let output = decoder.decode_program_data_logs(&context(), &logs, &[9]);
    assert!(output.diagnostics.is_empty());
    assert_eq!(output.events.len(), 1);
    let event = &output.events[0];
    assert_eq!(event.transport, EventTransport::ProgramDataLog);
    assert_eq!(event.event_name.as_deref(), Some("SwapExecuted"));
    assert_eq!(event.observation.key.instruction_path, vec![9, 0]);
    assert_eq!(event.observation.key.event_ordinal, 0);
}

#[test]
fn program_data_parser_is_bounded_and_never_attributes_after_stack_corruption() {
    let decoder = decoder();
    let logs = vec![
        format!("Program {DUSK_PROGRAM_ID} invoke [1]"),
        "Program data: %not-base64%".to_owned(),
        "Program log: bm90IGFuIGV2ZW50".to_owned(),
        format!("Program {LEVERAGE_DELEGATE_PROGRAM_ID} success"),
        "Program data: AQID".to_owned(),
    ];
    let output = decoder.decode_program_data_logs(&context(), &logs, &[4]);
    assert!(output.events.is_empty());
    assert_eq!(
        output
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.kind)
            .collect::<Vec<_>>(),
        vec![
            LogDiagnosticKind::InvalidBase64,
            LogDiagnosticKind::InvocationExitMismatch,
            LogDiagnosticKind::OrphanProgramData,
        ]
    );

    let huge = "A".repeat(decoder.limits.max_payload_bytes * 2);
    let logs = vec![
        format!("Program {DUSK_PROGRAM_ID} invoke [1]"),
        format!("Program data: {huge}"),
        format!("Program {DUSK_PROGRAM_ID} success"),
    ];
    let output = decoder.decode_program_data_logs(&context(), &logs, &[0]);
    assert_eq!(output.events.len(), 0);
    assert_eq!(
        output.diagnostics[0].kind,
        LogDiagnosticKind::OversizedProgramData
    );
}

#[test]
fn delegate_program_data_is_preserved_as_unknown_because_delegate_idl_has_no_events() {
    let decoder = decoder();
    let raw = [77_u8; 12];
    let logs = vec![
        format!("Program {LEVERAGE_DELEGATE_PROGRAM_ID} invoke [1]"),
        format!("Program data: {}", STANDARD.encode(raw)),
        format!("Program {LEVERAGE_DELEGATE_PROGRAM_ID} success"),
    ];
    let output = decoder.decode_program_data_logs(&context(), &logs, &[5]);
    assert!(output.diagnostics.is_empty());
    assert_eq!(output.events.len(), 1);
    assert_eq!(
        output.events[0].status,
        EventDecodeStatus::UnknownDiscriminator
    );
    assert_eq!(output.events[0].raw_event, raw);
    assert_eq!(
        output.events[0].observation.key.identity.program_id,
        LEVERAGE_DELEGATE_PROGRAM_ID
    );
}

#[test]
fn canonical_payload_hash_is_deterministic_and_transport_independent() {
    let decoder = decoder();
    let cpi = event_data(&decoder, "HlpOpened");
    let from_cpi = decoder
        .decode_event_cpi_instruction(&context(), DUSK_PROGRAM_ID, vec![0], 0, &cpi)
        .unwrap();
    let logs = vec![
        format!("Program {DUSK_PROGRAM_ID} invoke [1]"),
        format!("Program data: {}", STANDARD.encode(&cpi[8..])),
        format!("Program {DUSK_PROGRAM_ID} success"),
    ];
    let from_log = decoder.decode_program_data_logs(&context(), &logs, &[0]);
    assert_eq!(
        from_cpi.observation.payload_hash,
        from_log.events[0].observation.payload_hash
    );
    assert_eq!(from_cpi.raw_event, from_log.events[0].raw_event);
}

#[test]
fn instruction_envelopes_distinguish_event_cpi_unknown_and_short_data() {
    let decoder = decoder();
    let event = event_data(&decoder, "HlpClosed");
    assert_eq!(
        decoder
            .decode_instruction(DUSK_PROGRAM_ID, &event)
            .unwrap()
            .status,
        InstructionDecodeStatus::AnchorEventCpi
    );
    assert_eq!(
        decoder
            .decode_instruction(DUSK_PROGRAM_ID, &[255; 8])
            .unwrap()
            .status,
        InstructionDecodeStatus::UnknownDiscriminator
    );
    assert_eq!(
        decoder
            .decode_instruction(DUSK_PROGRAM_ID, &[1, 2, 3])
            .unwrap()
            .status,
        InstructionDecodeStatus::MissingDiscriminator
    );

    let (known_discriminator, _) = decoder
        .dusk
        .instructions
        .iter()
        .find(|(_, descriptor)| descriptor.name == "add_leverage_margin")
        .unwrap();
    let malformed = decoder
        .decode_instruction(DUSK_PROGRAM_ID, known_discriminator)
        .unwrap();
    assert_eq!(
        malformed.status,
        InstructionDecodeStatus::MalformedKnownArguments
    );
    assert_eq!(
        malformed.instruction_name.as_deref(),
        Some("add_leverage_margin")
    );
    assert!(malformed
        .decode_error
        .as_deref()
        .unwrap()
        .contains("truncated"));
    assert_eq!(malformed.raw_instruction, known_discriminator);
}

#[test]
fn registry_classifies_all_10_dusk_and_four_delegate_account_declarations() {
    let decoder = decoder();
    let dusk: BTreeSet<_> = decoder
        .account_names(PinnedProgram::Dusk)
        .into_iter()
        .collect();
    let delegate: BTreeSet<_> = decoder
        .account_names(PinnedProgram::LeverageDelegate)
        .into_iter()
        .collect();
    assert_eq!(dusk, DUSK_ACCOUNTS.into_iter().collect());
    assert_eq!(delegate, DELEGATE_ACCOUNTS.into_iter().collect());
    assert_eq!(decoder.dusk.accounts.len(), 10);
    assert_eq!(decoder.delegate.accounts.len(), 4);

    let mut idl: Value = serde_json::from_slice(DUSK_IDL).unwrap();
    idl["accounts"][0]["discriminator"][0] = json!(0);
    let tampered = serde_json::to_vec(&idl).unwrap();
    assert!(matches!(
        ProgramRegistry::from_bytes(&tampered, DUSK_PROGRAM_ID),
        Err(DecoderError::InvalidIdl(message)) if message.contains("account") && message.contains("discriminator")
    ));
}

#[test]
fn all_14_pinned_account_declarations_decode_and_project_deterministically() {
    let decoder = decoder();
    for (program, names) in [
        (PinnedProgram::Dusk, DUSK_ACCOUNTS.as_slice()),
        (
            PinnedProgram::LeverageDelegate,
            DELEGATE_ACCOUNTS.as_slice(),
        ),
    ] {
        for name in names {
            let data = account_data(&decoder, program, name);
            let decoded = decoder
                .decode_account(&account_context(), program.program_id(), &data)
                .unwrap();
            assert_eq!(decoded.status, AccountDecodeStatus::Decoded, "{name}");
            assert_eq!(decoded.account_name.as_deref(), Some(*name));
            assert!(decoded.decoded_fields.is_some(), "{name}");
            assert!(decoded.projection_error.is_none(), "{name}");
            assert_eq!(decoded.raw_account, data, "{name}");
            assert_eq!(decoded.allocation_padding_bytes, 0, "{name}");
            assert_eq!(
                decoded.freshness.identity.program_id,
                program.program_id(),
                "{name}"
            );
            decoded.freshness.validate().unwrap();
            let expected_scope =
                if program == PinnedProgram::LeverageDelegate && *name != "LeverageOrder" {
                    AccountLayoutScope::ReferencedExternalLayout
                } else {
                    AccountLayoutScope::ExpectedProgramOwned
                };
            assert_eq!(decoded.layout_scope, Some(expected_scope), "{name}");
            if expected_scope == AccountLayoutScope::ReferencedExternalLayout {
                assert_eq!(decoded.projections, AccountProjections::default(), "{name}");
            }
        }
    }
}

#[test]
fn shared_account_discriminators_never_override_runtime_owner_identity() {
    let decoder = decoder();
    let dusk_data = account_data(&decoder, PinnedProgram::Dusk, "Market");
    let delegate_data = account_data(&decoder, PinnedProgram::LeverageDelegate, "Market");
    assert_eq!(dusk_data, delegate_data);

    let dusk = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &dusk_data)
        .unwrap();
    let delegate = decoder
        .decode_account(
            &account_context(),
            LEVERAGE_DELEGATE_PROGRAM_ID,
            &delegate_data,
        )
        .unwrap();
    assert_eq!(dusk.account_name.as_deref(), Some("Market"));
    assert_eq!(delegate.account_name.as_deref(), Some("Market"));
    assert_eq!(dusk.freshness.data_hash, delegate.freshness.data_hash);
    assert_ne!(
        dusk.freshness.identity.program_id,
        delegate.freshness.identity.program_id
    );
    assert_ne!(
        dusk.freshness.identity.idl_hash,
        delegate.freshness.identity.idl_hash
    );
}

#[test]
fn account_allocation_padding_is_explicit_and_nonzero_trailing_data_is_malformed() {
    let decoder = decoder();
    let mut padded = account_data(&decoder, PinnedProgram::Dusk, "Market");
    padded.extend_from_slice(&[0; 32]);
    let decoded = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &padded)
        .unwrap();
    assert_eq!(decoded.status, AccountDecodeStatus::Decoded);
    assert_eq!(decoded.allocation_padding_bytes, 32);
    assert_eq!(decoded.raw_account, padded);

    let mut ambiguous = account_data(&decoder, PinnedProgram::Dusk, "Market");
    ambiguous.extend_from_slice(&[0, 0, 7]);
    let decoded = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &ambiguous)
        .unwrap();
    assert_eq!(decoded.status, AccountDecodeStatus::MalformedKnownPayload);
    assert!(decoded
        .decode_error
        .as_deref()
        .unwrap()
        .contains("non-zero trailing byte"));
    assert_eq!(decoded.raw_account, ambiguous);
}

#[test]
fn unknown_missing_and_truncated_accounts_preserve_raw_data_and_freshness() {
    let decoder = decoder();
    let mut unknown = vec![255; 8];
    unknown.extend_from_slice(&[4, 5, 6]);
    let decoded = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &unknown)
        .unwrap();
    assert_eq!(decoded.status, AccountDecodeStatus::UnknownDiscriminator);
    assert_eq!(decoded.raw_account, unknown);
    assert_eq!(decoded.payload, vec![4, 5, 6]);
    decoded.freshness.validate().unwrap();

    let short = vec![1, 2, 3];
    let decoded = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &short)
        .unwrap();
    assert_eq!(decoded.status, AccountDecodeStatus::MissingDiscriminator);
    assert_eq!(decoded.raw_account, short);

    let known = account_data(&decoder, PinnedProgram::Dusk, "BorrowPosition");
    let truncated = known[..12].to_vec();
    let decoded = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &truncated)
        .unwrap();
    assert_eq!(decoded.status, AccountDecodeStatus::MalformedKnownPayload);
    assert_eq!(decoded.account_name.as_deref(), Some("BorrowPosition"));
    assert_eq!(decoded.raw_account, truncated);
    assert!(decoded
        .decode_error
        .as_deref()
        .unwrap()
        .contains("truncated"));
}

#[test]
fn market_and_keeper_projections_cover_curve_and_all_protocol_auction_lanes() {
    let decoder = decoder();
    let data = account_data(&decoder, PinnedProgram::Dusk, "Market");
    let decoded = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &data)
        .unwrap();
    let market = decoded.projections.market.as_ref().unwrap();
    assert_eq!(market.amm_kind, AmmKind::ConstantProduct);
    assert_eq!(market.auction_lanes.len(), 8);
    assert_eq!(decoded.projections.keeper_discovery.len(), 8);
    assert_eq!(market.base.live_reserve.as_str(), "0");
    assert_eq!(market.params_hash_hex, format!("0x{}", "00".repeat(32)));

    let mut fields = decoded.decoded_fields.unwrap();
    fields["config"]["amm"]["peak_depth_nad"] = json!("1");
    let concentrated = projections::build_product_projections(
        "Market",
        &account_context().account_pubkey,
        &fields,
    )
    .unwrap();
    let market = concentrated.market.unwrap();
    assert_eq!(market.amm_kind, AmmKind::ConstantProduct);
    assert_eq!(market.configured_amm_kind, AmmKind::Concentrated);

    fields["amm"]["applied_curve_parameters"]["peak_depth_nad"] = json!("1");
    let concentrated = projections::build_product_projections(
        "Market",
        &account_context().account_pubkey,
        &fields,
    )
    .unwrap();
    assert_eq!(concentrated.market.unwrap().amm_kind, AmmKind::Concentrated);
}

#[test]
fn portfolio_and_keeper_projection_values_remain_lossless_and_semantically_bounded() {
    let decoder = decoder();
    let data = account_data(&decoder, PinnedProgram::Dusk, "BorrowPosition");
    let decoded = decoder
        .decode_account(&account_context(), DUSK_PROGRAM_ID, &data)
        .unwrap();
    let mut fields = decoded.decoded_fields.unwrap();
    fields["fixed_base_shares"] = json!(u128::MAX.to_string());
    fields["auction_debt_asset"] = json!("9");
    let projected = projections::build_product_projections(
        "BorrowPosition",
        &account_context().account_pubkey,
        &fields,
    )
    .unwrap();
    let PortfolioProjection::BorrowPosition(portfolio) = projected.portfolio.unwrap() else {
        panic!("expected borrow portfolio projection");
    };
    assert_eq!(portfolio.fixed_base_shares.as_str(), u128::MAX.to_string());
    let KeeperDiscoveryProjection::BorrowLiquidation(keeper) = &projected.keeper_discovery[0]
    else {
        panic!("expected borrow liquidation discovery projection");
    };
    assert_eq!(keeper.auction_debt_asset, AssetSide::Unknown(9));
}

#[test]
fn account_context_rejects_identity_and_freshness_ambiguity() {
    let decoder = decoder();
    let data = account_data(&decoder, PinnedProgram::Dusk, "YieldAccount");
    let mut invalid = account_context();
    invalid.account_pubkey = "not-a-pubkey".to_owned();
    assert!(matches!(
        decoder.decode_account(&invalid, DUSK_PROGRAM_ID, &data),
        Err(DecoderError::InvalidAccountContext(_))
    ));
    let mut invalid = account_context();
    invalid.source.clear();
    assert!(matches!(
        decoder.decode_account(&invalid, DUSK_PROGRAM_ID, &data),
        Err(DecoderError::InvalidAccountContext(_))
    ));
    assert!(matches!(
        decoder.decode_account(
            &account_context(),
            "11111111111111111111111111111111",
            &data
        ),
        Err(DecoderError::UnpinnedProgram(_))
    ));
}
