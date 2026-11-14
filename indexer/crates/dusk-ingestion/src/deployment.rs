//! The deployed program identity and the first slot attributable to this
//! release.
use {
    crate::{
        DUSK_IDL_SHA256, DUSK_PROGRAM_ID, FoundationError, LEVERAGE_DELEGATE_IDL_SHA256,
        LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION, sha256_hex, vendored_protocol_lock,
    },
    serde::{Deserialize, Serialize},
    solana_pubkey::Pubkey,
    std::str::FromStr,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterPin {
    pub name: String,
    pub genesis_hash: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BinaryPin {
    pub sha256: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdlPin {
    pub sha256: String,
    pub canonical_sha256: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramDeployment {
    pub program_data: String,
    pub deploy_slot: u64,
    pub upgrade_authority: Option<String>,
    pub allocated_binary_bytes: usize,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramPin {
    pub name: String,
    pub program_id: String,
    pub binary: BinaryPin,
    pub idl: IdlPin,
    pub deployment: ProgramDeployment,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeploymentPin {
    pub revision: String,
    pub cluster: ClusterPin,
    pub programs: Vec<ProgramPin>,
}

impl DeploymentPin {
    pub fn from_value(value: serde_json::Value) -> Result<Self, FoundationError> {
        if value["programs"].as_array().is_some_and(|programs| {
            programs
                .iter()
                .any(|program| program["deployment"].get("upgradeAuthority").is_none())
        }) {
            return Err(FoundationError::InvalidProtocolLock(
                "upgrade authority must be present, including explicit null".into(),
            ));
        }
        let mut pin: Self = serde_json::from_value(value)
            .map_err(|error| FoundationError::InvalidProtocolLock(error.to_string()))?;
        let invalid =
            || FoundationError::InvalidProtocolLock("invalid deployed program identity".into());
        if pin.revision != PROTOCOL_REVISION
            || pin.cluster.name != "devnet"
            || pin.cluster.genesis_hash != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
            || pin.programs.len() != 2
        {
            return Err(invalid());
        }
        pin.programs
            .sort_by(|left, right| left.name.cmp(&right.name));
        let loader = Pubkey::from_str("BPFLoaderUpgradeab1e11111111111111111111111")
            .map_err(|_| invalid())?;
        for (program, (name, id, idl)) in pin.programs.iter().zip([
            ("dusk", DUSK_PROGRAM_ID, DUSK_IDL_SHA256),
            (
                "leverage_delegate",
                LEVERAGE_DELEGATE_PROGRAM_ID,
                LEVERAGE_DELEGATE_IDL_SHA256,
            ),
        ]) {
            let key = Pubkey::from_str(&program.program_id).map_err(|_| invalid())?;
            let data = &program.deployment;
            if program.name != name
                || program.program_id != id
                || program.idl.canonical_sha256 != idl
                || !crate::is_sha256(&program.binary.sha256)
                || !crate::is_sha256(&program.idl.sha256)
                || data.deploy_slot == 0
                || data.deploy_slot >= 9_007_199_254_740_991
                || !(4..=16 * 1024 * 1024).contains(&data.allocated_binary_bytes)
                || Pubkey::find_program_address(&[key.as_ref()], &loader)
                    .0
                    .to_string()
                    != data.program_data
                || data
                    .upgrade_authority
                    .as_ref()
                    .is_some_and(|key| Pubkey::from_str(key).is_err())
            {
                return Err(invalid());
            }
        }
        Ok(pin)
    }

    /// An upgrade becomes usable in the following slot. A composite release
    /// starts only once both pinned programs are active.
    pub fn first_slot(&self) -> u64 {
        self.programs
            .iter()
            .map(|program| program.deployment.deploy_slot)
            .max()
            .expect("validated programs")
            + 1
    }
    pub fn payload(&self) -> String {
        serde_json::to_string(self).expect("serializable deployment pin")
    }
    pub fn sha256(&self) -> String {
        sha256_hex(self.payload().as_bytes())
    }
}
pub fn pinned_deployment() -> Result<DeploymentPin, FoundationError> {
    DeploymentPin::from_value(vendored_protocol_lock())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibleProgram {
    program_id: String,
    idl_canonical_sha256: String,
    deploy_slot: u64,
    binary_sha256: String,
    allocated_binary_bytes: usize,
}

impl CompatibleProgram {
    fn apply(self, program: &mut ProgramPin) -> Result<(), FoundationError> {
        let original = &program.deployment;
        if self.program_id != program.program_id
            || self.idl_canonical_sha256 != program.idl.canonical_sha256
            || self.deploy_slot < original.deploy_slot
            || self.deploy_slot >= 9_007_199_254_740_991
            || !crate::is_sha256(&self.binary_sha256)
            || !(4..=16 * 1024 * 1024).contains(&self.allocated_binary_bytes)
            || (self.deploy_slot == original.deploy_slot
                && (self.binary_sha256 != program.binary.sha256
                    || self.allocated_binary_bytes != original.allocated_binary_bytes))
        {
            return Err(FoundationError::InvalidProtocolLock(
                "compatible deployment differs from the event revision or IDL".into(),
            ));
        }
        program.deployment.deploy_slot = self.deploy_slot;
        program.deployment.allocated_binary_bytes = self.allocated_binary_bytes;
        program.binary.sha256 = self.binary_sha256;
        Ok(())
    }
}

/// The current, byte-verified executables for the same event/IDL revision.
/// The original lock remains immutable because its first slot and stored
/// observations identify the beginning of the continuous event history.
pub fn current_deployment() -> Result<DeploymentPin, FoundationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CompatibleDeployment {
        event_revision: String,
        #[serde(flatten)]
        dusk: CompatibleProgram,
        leverage_delegate: Option<CompatibleProgram>,
    }

    let mut pin = pinned_deployment()?;
    let upgrade: CompatibleDeployment = serde_json::from_str(include_str!(
        "../../../../protocol/compatible-deployment.json"
    ))
    .map_err(|error| FoundationError::InvalidProtocolLock(error.to_string()))?;
    if upgrade.event_revision != pin.revision {
        return Err(FoundationError::InvalidProtocolLock(
            "compatible deployment differs from the event revision or IDL".into(),
        ));
    }
    // from_value validates the complete, sorted two-program pin.
    upgrade.dusk.apply(&mut pin.programs[0])?;
    if let Some(delegate) = upgrade.leverage_delegate {
        delegate.apply(&mut pin.programs[1])?;
    }
    Ok(pin)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interval_starts_after_both_programs_are_active() {
        let pin = pinned_deployment().unwrap();
        assert_eq!(pin.first_slot(), 521_967_169);
        let archived: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../protocol/archive/next-2026-10-31-layouts/protocol.lock.json"
        ))
        .unwrap();
        let archived_first = archived["programs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|program| program["deployment"]["deploySlot"].as_u64().unwrap())
            .max()
            .unwrap()
            + 1;
        assert_eq!(archived_first, 517_184_937);
        assert!(DeploymentPin::from_value(archived).is_err());
        let mut reordered = vendored_protocol_lock();
        reordered["programs"].as_array_mut().unwrap().reverse();
        assert_eq!(
            pin.sha256(),
            DeploymentPin::from_value(reordered).unwrap().sha256()
        );
    }
    #[test]
    fn compatible_deployment_matches_the_active_event_boundary() {
        let historical = pinned_deployment().unwrap();
        let current = current_deployment().unwrap();
        assert_eq!(historical.revision, current.revision);
        assert_eq!(historical.first_slot(), 521_967_169);
        let metadata: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../protocol/compatible-deployment.json"
        ))
        .unwrap();
        for (index, (before, after)) in historical
            .programs
            .iter()
            .zip(&current.programs)
            .enumerate()
        {
            assert_eq!(before.program_id, after.program_id);
            assert_eq!(before.idl.canonical_sha256, after.idl.canonical_sha256);
            assert_eq!(
                before.deployment.program_data,
                after.deployment.program_data
            );
            let entry = if index == 0 {
                &metadata
            } else {
                &metadata["leverageDelegate"]
            };
            if entry.is_null() {
                assert_eq!(before.deployment.deploy_slot, after.deployment.deploy_slot);
                assert_eq!(before.binary.sha256, after.binary.sha256);
            } else {
                assert_eq!(
                    Some(after.deployment.deploy_slot),
                    entry["deploySlot"].as_u64()
                );
                assert_eq!(
                    Some(after.binary.sha256.as_str()),
                    entry["binarySha256"].as_str()
                );
            }
        }
    }

    #[test]
    fn compatible_program_rejects_changed_identity_and_conflicting_original_slot() {
        let pin = pinned_deployment().unwrap();
        let dusk = &pin.programs[0];
        let delegate = &pin.programs[1];
        let original = serde_json::json!({
            "programId": delegate.program_id,
            "idlCanonicalSha256": delegate.idl.canonical_sha256,
            "deploySlot": delegate.deployment.deploy_slot,
            "binarySha256": delegate.binary.sha256,
            "allocatedBinaryBytes": delegate.deployment.allocated_binary_bytes,
        });
        for (field, value) in [
            ("programId", serde_json::json!(dusk.program_id)),
            (
                "idlCanonicalSha256",
                serde_json::json!(dusk.idl.canonical_sha256),
            ),
            (
                "deploySlot",
                serde_json::json!(delegate.deployment.deploy_slot - 1),
            ),
            ("binarySha256", serde_json::json!(dusk.binary.sha256)),
        ] {
            let mut metadata = original.clone();
            metadata[field] = value;
            let upgrade: CompatibleProgram = serde_json::from_value(metadata).unwrap();
            assert!(upgrade.apply(&mut delegate.clone()).is_err(), "{field}");
        }
    }
    #[test]
    fn incomplete_or_foreign_deployment_metadata_is_rejected() {
        for case in [
            "missing",
            "program_data",
            "slot",
            "authority",
            "duplicate",
            "cluster",
        ] {
            let mut lock = vendored_protocol_lock();
            match case {
                "missing" => {
                    lock["programs"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("deployment");
                }
                "program_data" => {
                    lock["programs"][0]["deployment"]["programData"] =
                        serde_json::json!(DUSK_PROGRAM_ID)
                }
                "slot" => lock["programs"][0]["deployment"]["deploySlot"] = serde_json::json!(0),
                "authority" => {
                    lock["programs"][0]["deployment"]["upgradeAuthority"] =
                        serde_json::json!("invalid")
                }
                "duplicate" => lock["programs"][1] = lock["programs"][0].clone(),
                _ => lock["cluster"]["name"] = serde_json::json!("mainnet-beta"),
            }
            assert!(DeploymentPin::from_value(lock).is_err(), "{case}");
        }
    }
}
