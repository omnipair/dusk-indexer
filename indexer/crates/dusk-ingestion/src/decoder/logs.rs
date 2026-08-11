use {
    super::{
        DecodedEventEnvelope, EventOccurrence, EventTransport, PinnedIdlDecoder,
        TransactionObservationContext,
    },
    base64::{Engine, engine::general_purpose::STANDARD},
    serde::{Deserialize, Serialize},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogDiagnosticKind {
    InvalidInvocation,
    InvocationDepthMismatch,
    MissingOuterInstructionIndex,
    InvocationExitMismatch,
    OrphanProgramData,
    OversizedProgramData,
    InvalidBase64,
    EventOrdinalOverflow,
    DecodeFailure,
    UnclosedInvocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogDiagnostic {
    pub line_index: usize,
    pub kind: LogDiagnosticKind,
    pub message: String,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogDecodeOutput {
    pub events: Vec<DecodedEventEnvelope>,
    pub diagnostics: Vec<LogDiagnostic>,
}

#[derive(Debug)]
struct InvocationFrame {
    program_id: String,
    path: Option<Vec<u16>>,
    next_child_index: u32,
    next_event_ordinal: u32,
}

pub(super) fn decode_program_data_logs(
    decoder: &PinnedIdlDecoder,
    context: &TransactionObservationContext,
    logs: &[String],
    outer_instruction_indices: &[u16],
) -> LogDecodeOutput {
    let mut output = LogDecodeOutput::default();
    let mut stack: Vec<InvocationFrame> = Vec::new();
    let mut root_invocations = 0_usize;

    for (line_index, line) in logs.iter().enumerate() {
        if let Some((program_id, depth)) = parse_invoke(line) {
            if depth == 0 {
                push_diagnostic(
                    &mut output,
                    line_index,
                    LogDiagnosticKind::InvalidInvocation,
                    "Solana invocation depth must start at one",
                );
                stack.clear();
                continue;
            }
            if depth != stack.len() + 1 {
                push_diagnostic(
                    &mut output,
                    line_index,
                    LogDiagnosticKind::InvocationDepthMismatch,
                    format!(
                        "invocation reports depth {depth}, but the active stack expects {}",
                        stack.len() + 1
                    ),
                );
                stack.clear();
            }

            let path = if depth == 1 {
                let path = outer_instruction_indices
                    .get(root_invocations)
                    .copied()
                    .map(|index| vec![index]);
                if path.is_none() {
                    push_diagnostic(
                        &mut output,
                        line_index,
                        LogDiagnosticKind::MissingOuterInstructionIndex,
                        format!(
                            "no caller-supplied outer instruction index for root invocation {}",
                            root_invocations
                        ),
                    );
                }
                root_invocations = root_invocations.saturating_add(1);
                path
            } else {
                stack.last_mut().and_then(|parent| {
                    let child_index = match u16::try_from(parent.next_child_index) {
                        Ok(index) => index,
                        Err(_) => {
                            push_diagnostic(
                                &mut output,
                                line_index,
                                LogDiagnosticKind::InvalidInvocation,
                                "nested instruction index exceeds u16",
                            );
                            return None;
                        }
                    };
                    parent.next_child_index = parent.next_child_index.saturating_add(1);
                    parent.path.as_ref().map(|parent_path| {
                        let mut path = parent_path.clone();
                        path.push(child_index);
                        path
                    })
                })
            };

            stack.push(InvocationFrame {
                program_id: program_id.to_owned(),
                path,
                next_child_index: 0,
                next_event_ordinal: 0,
            });
            continue;
        }

        if let Some(program_id) = parse_exit(line) {
            match stack.last() {
                Some(frame) if frame.program_id == program_id => {
                    stack.pop();
                }
                Some(frame) => {
                    push_diagnostic(
                        &mut output,
                        line_index,
                        LogDiagnosticKind::InvocationExitMismatch,
                        format!(
                            "program {program_id} exited while {} was active; attribution reset",
                            frame.program_id
                        ),
                    );
                    stack.clear();
                }
                None => push_diagnostic(
                    &mut output,
                    line_index,
                    LogDiagnosticKind::InvocationExitMismatch,
                    format!("program {program_id} exited with no active invocation"),
                ),
            }
            continue;
        }

        let Some(encoded) = line.strip_prefix("Program data: ") else {
            continue;
        };
        let Some(frame) = stack.last_mut() else {
            push_diagnostic(
                &mut output,
                line_index,
                LogDiagnosticKind::OrphanProgramData,
                "Program data appeared outside an invocation",
            );
            continue;
        };
        if decoder.program_for_id(&frame.program_id).is_err() {
            continue;
        }

        let ordinal = match u16::try_from(frame.next_event_ordinal) {
            Ok(ordinal) => ordinal,
            Err(_) => {
                push_diagnostic(
                    &mut output,
                    line_index,
                    LogDiagnosticKind::EventOrdinalOverflow,
                    "more than 65,536 events appeared at one instruction path",
                );
                continue;
            }
        };
        frame.next_event_ordinal = frame.next_event_ordinal.saturating_add(1);
        let Some(path) = frame.path.clone() else {
            continue;
        };

        let maximum_encoded = decoder
            .limits
            .max_payload_bytes
            .saturating_add(2)
            .saturating_div(3)
            .saturating_mul(4);
        if encoded.len() > maximum_encoded {
            push_diagnostic(
                &mut output,
                line_index,
                LogDiagnosticKind::OversizedProgramData,
                format!(
                    "base64 value has {} characters; maximum is {maximum_encoded}",
                    encoded.len()
                ),
            );
            continue;
        }
        let raw_event = match STANDARD.decode(encoded) {
            Ok(bytes) => bytes,
            Err(error) => {
                push_diagnostic(
                    &mut output,
                    line_index,
                    LogDiagnosticKind::InvalidBase64,
                    format!("invalid Program data base64: {error}"),
                );
                continue;
            }
        };
        if raw_event.len() > decoder.limits.max_payload_bytes {
            push_diagnostic(
                &mut output,
                line_index,
                LogDiagnosticKind::OversizedProgramData,
                format!(
                    "decoded Program data has {} bytes; maximum is {}",
                    raw_event.len(),
                    decoder.limits.max_payload_bytes
                ),
            );
            continue;
        }
        match decoder.decode_raw_event(
            context,
            decoder
                .program_for_id(&frame.program_id)
                .expect("pinned program was checked above"),
            EventOccurrence {
                instruction_path: path,
                event_ordinal: ordinal,
                transport: EventTransport::ProgramDataLog,
            },
            raw_event.clone(),
            &raw_event,
        ) {
            Ok(event) => output.events.push(event),
            Err(error) => push_diagnostic(
                &mut output,
                line_index,
                LogDiagnosticKind::DecodeFailure,
                error.to_string(),
            ),
        }
    }

    if !stack.is_empty() {
        push_diagnostic(
            &mut output,
            logs.len(),
            LogDiagnosticKind::UnclosedInvocation,
            format!("{} invocation frame(s) were not closed", stack.len()),
        );
    }
    output
}

fn parse_invoke(line: &str) -> Option<(&str, usize)> {
    let remainder = line.strip_prefix("Program ")?;
    let (program_id, depth) = remainder.rsplit_once(" invoke [")?;
    let depth = depth.strip_suffix(']')?.parse().ok()?;
    if program_id.is_empty() {
        return None;
    }
    Some((program_id, depth))
}

fn parse_exit(line: &str) -> Option<&str> {
    let remainder = line.strip_prefix("Program ")?;
    if let Some(program_id) = remainder.strip_suffix(" success") {
        return Some(program_id);
    }
    remainder
        .split_once(" failed:")
        .map(|(program_id, _)| program_id)
}

fn push_diagnostic(
    output: &mut LogDecodeOutput,
    line_index: usize,
    kind: LogDiagnosticKind,
    message: impl Into<String>,
) {
    output.diagnostics.push(LogDiagnostic {
        line_index,
        kind,
        message: message.into(),
    });
}
