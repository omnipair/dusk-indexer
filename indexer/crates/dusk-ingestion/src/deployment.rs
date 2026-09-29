//! The deployed program identity and the first slot attributable to this
//! release.
use {
    crate::{
        sha256_hex, vendored_protocol_lock, FoundationError, DUSK_IDL_SHA256, DUSK_PROGRAM_ID,
        LEVERAGE_DELEGATE_IDL_SHA256, LEVERAGE_DELEGATE_PROGRAM_ID, PROTOCOL_REVISION,
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

/// The current, byte-verified executable for the same event/IDL revision.
/// The original lock remains immutable because its first slot and stored
/// observations identify the beginning of the continuous event history.
pub fn current_deployment() -> Result<DeploymentPin, FoundationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CompatibleDeployment {
        event_revision: String,
        program_id: String,
        idl_canonical_sha256: String,
        deploy_slot: u64,
        binary_sha256: String,
        allocated_binary_bytes: usize,
    }

    let mut pin = pinned_deployment()?;
    let upgrade: CompatibleDeployment = serde_json::from_str(include_str!(
        "../../../../protocol/compatible-deployment.json"
    ))
    .map_err(|error| FoundationError::InvalidProtocolLock(error.to_string()))?;
    let dusk = pin
        .programs
        .iter_mut()
        .find(|program| program.name == "dusk")
        .expect("validated Dusk pin");
    if upgrade.event_revision != pin.revision
        || upgrade.program_id != dusk.program_id
        || upgrade.idl_canonical_sha256 != dusk.idl.canonical_sha256
        || upgrade.deploy_slot <= dusk.deployment.deploy_slot
        || upgrade.deploy_slot >= 9_007_199_254_740_991
        || !crate::is_sha256(&upgrade.binary_sha256)
        || !(4..=16 * 1024 * 1024).contains(&upgrade.allocated_binary_bytes)
    {
        return Err(FoundationError::InvalidProtocolLock(
            "compatible deployment differs from the event revision or IDL".into(),
        ));
    }
    dusk.deployment.deploy_slot = upgrade.deploy_slot;
    dusk.deployment.allocated_binary_bytes = upgrade.allocated_binary_bytes;
    dusk.binary.sha256 = upgrade.binary_sha256;
    Ok(pin)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interval_starts_after_both_programs_are_active() {
        let pin = pinned_deployment().unwrap();
        assert_eq!(pin.first_slot(), 504_809_897);
        let mut reordered = vendored_protocol_lock();
        reordered["programs"].as_array_mut().unwrap().reverse();
        assert_eq!(
            pin.sha256(),
            DeploymentPin::from_value(reordered).unwrap().sha256()
        );
    }
    #[test]
    fn compatible_upgrade_keeps_the_original_event_boundary() {
        let historical = pinned_deployment().unwrap();
        let current = current_deployment().unwrap();
        assert_eq!(historical.revision, current.revision);
        assert_eq!(
            historical.programs[0].idl.canonical_sha256,
            current.programs[0].idl.canonical_sha256
        );
        assert_eq!(historical.first_slot(), 504_809_897);
        assert_eq!(current.programs[0].deployment.deploy_slot, 505_509_130);
        assert_eq!(
            current.programs[0].binary.sha256,
            "f07fcad12a6b41d74fba69b557585c1dccd7f515677f82a5dc811832cac0f849"
        );
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
