//! Direct RPC attestation and the finalized interval owned by this release.
use {
    anyhow::{bail, Context, Result},
    dusk_indexer_foundation::{
        deployment::{pinned_deployment, DeploymentPin},
        sha256_hex,
    },
    solana_account::Account,
    solana_account_decoder_client_types::{UiAccountEncoding, UiDataSliceConfig},
    solana_client::{nonblocking::rpc_client::RpcClient, rpc_config::RpcAccountInfoConfig},
    solana_commitment_config::CommitmentConfig,
    solana_pubkey::Pubkey,
    std::str::FromStr,
};

#[derive(Clone, Copy, Debug)]
pub struct DeploymentWindow {
    pub first_slot: u64,
    pub through_slot: u64,
}
impl DeploymentWindow {
    pub fn require_slot(&self, slot: u64) -> Result<()> {
        if slot < self.first_slot || slot > self.through_slot {
            bail!("FINALIZED_INVARIANT: transaction is outside the attested deployment interval");
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Attestation {
    verified_binary: bool,
    minimum_slot: u64,
}
impl Attestation {
    pub fn window(&self) -> Result<DeploymentWindow> {
        if !self.verified_binary {
            bail!("FINALIZED_INVARIANT: deployment has not been attested");
        }
        Ok(DeploymentWindow {
            first_slot: pinned_deployment()?.first_slot(),
            through_slot: self.minimum_slot,
        })
    }
    pub async fn verify(&mut self, rpc: &RpcClient, cluster: &str) -> Result<()> {
        self.verify_at(rpc, cluster, 0).await
    }
    pub async fn verify_at(&mut self, rpc: &RpcClient, cluster: &str, minimum: u64) -> Result<()> {
        let pin = pinned_deployment()?;
        if pin.cluster.name != cluster {
            bail!("FINALIZED_INVARIANT: cluster label differs from protocol lock");
        }
        let genesis = rpc
            .get_genesis_hash()
            .await
            .map_err(|_| anyhow::anyhow!("RPC genesis lookup failed"))?;
        if pin.cluster.genesis_hash != genesis.to_string() {
            bail!("FINALIZED_INVARIANT: RPC genesis differs from protocol lock");
        }
        let addresses = pin
            .programs
            .iter()
            .flat_map(|program| [&program.program_id, &program.deployment.program_data])
            .map(|address| Pubkey::from_str(address))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let minimum = minimum.max(self.minimum_slot).max(pin.first_slot());
        let full = !self.verified_binary;
        let response = rpc
            .get_multiple_accounts_with_config(
                &addresses,
                RpcAccountInfoConfig {
                    encoding: Some(UiAccountEncoding::Base64),
                    data_slice: (!full).then_some(UiDataSliceConfig {
                        offset: 0,
                        length: 45,
                    }),
                    commitment: Some(CommitmentConfig::finalized()),
                    min_context_slot: Some(minimum),
                },
            )
            .await
            .map_err(|_| anyhow::anyhow!("RPC program attestation failed"))?;
        verify_accounts(&pin, &response.value, response.context.slot, minimum, full)?;
        if rpc
            .get_genesis_hash()
            .await
            .map_err(|_| anyhow::anyhow!("RPC genesis recheck failed"))?
            != genesis
        {
            bail!("FINALIZED_INVARIANT: RPC cluster changed during attestation");
        }
        self.verified_binary = true;
        self.minimum_slot = response.context.slot;
        Ok(())
    }
}

fn verify_accounts(
    pin: &DeploymentPin,
    accounts: &[Option<Account>],
    slot: u64,
    minimum: u64,
    full: bool,
) -> Result<()> {
    if slot < minimum || accounts.len() != pin.programs.len() * 2 {
        bail!("FINALIZED_INVARIANT: incomplete or regressed deployment observation");
    }
    let loader = Pubkey::from_str("BPFLoaderUpgradeab1e11111111111111111111111")?;
    for (program, pair) in pin.programs.iter().zip(accounts.chunks_exact(2)) {
        let executable = pair[0]
            .as_ref()
            .context("FINALIZED_INVARIANT: pinned program missing")?;
        let data = pair[1]
            .as_ref()
            .context("FINALIZED_INVARIANT: pinned ProgramData missing")?;
        let deployment = &program.deployment;
        if executable.owner != loader
            || data.owner != loader
            || !executable.executable
            || data.executable
            || executable.lamports == 0
            || data.lamports == 0
            || executable.data.len() != 36
            || executable.data[..4] != 2_u32.to_le_bytes()
            || Pubkey::new_from_array(executable.data[4..36].try_into()?).to_string()
                != deployment.program_data
            || data.data.len()
                != if full {
                    45 + deployment.allocated_binary_bytes
                } else {
                    45
                }
            || data.data[..4] != 3_u32.to_le_bytes()
            || data.data[12] > 1
        {
            bail!("FINALIZED_INVARIANT: pinned program loader, link, flags or allocation mismatch");
        }
        let deploy_slot = u64::from_le_bytes(data.data[4..12].try_into()?);
        let authority = if data.data[12] == 0 {
            None
        } else {
            Some(Pubkey::new_from_array(data.data[13..45].try_into()?).to_string())
        };
        if deploy_slot != deployment.deploy_slot || authority != deployment.upgrade_authority {
            bail!("FINALIZED_INVARIANT: deployment slot or upgrade authority differs from lock");
        }
        if full && sha256_hex(&data.data[45..]) != program.binary.sha256 {
            bail!("FINALIZED_INVARIANT: on-chain binary differs from protocol lock");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (DeploymentPin, Vec<Option<Account>>) {
        let mut pin = pinned_deployment().unwrap();
        let loader = Pubkey::from_str("BPFLoaderUpgradeab1e11111111111111111111111").unwrap();
        let mut accounts = Vec::new();
        for program in &mut pin.programs {
            let bytes = [127, 69, 76, 70];
            program.binary.sha256 = sha256_hex(&bytes);
            program.deployment.allocated_binary_bytes = bytes.len();
            let mut executable = 2_u32.to_le_bytes().to_vec();
            executable.extend(
                Pubkey::from_str(&program.deployment.program_data)
                    .unwrap()
                    .to_bytes(),
            );
            accounts.push(Some(Account {
                data: executable,
                owner: loader,
                executable: true,
                lamports: 1,
                rent_epoch: 0,
            }));
            let mut data = 3_u32.to_le_bytes().to_vec();
            data.extend(program.deployment.deploy_slot.to_le_bytes());
            data.push(1);
            data.extend(
                Pubkey::from_str(program.deployment.upgrade_authority.as_ref().unwrap())
                    .unwrap()
                    .to_bytes(),
            );
            data.extend(bytes);
            accounts.push(Some(Account {
                data,
                owner: loader,
                executable: false,
                lamports: 1,
                rent_epoch: 0,
            }));
        }
        (pin, accounts)
    }
    #[test]
    fn binary_and_header_checks_reject_changed_release_metadata() {
        let (pin, accounts) = fixture();
        let slot = pin.first_slot();
        verify_accounts(&pin, &accounts, slot, slot, true).unwrap();
        for case in [
            "authority",
            "slot",
            "link",
            "owner",
            "executable",
            "binary",
            "allocation",
        ] {
            let mut changed = accounts.clone();
            match case {
                "authority" => changed[1].as_mut().unwrap().data[13] ^= 1,
                "slot" => changed[1].as_mut().unwrap().data[4] ^= 1,
                "link" => changed[0].as_mut().unwrap().data[4] ^= 1,
                "owner" => changed[1].as_mut().unwrap().owner = Pubkey::default(),
                "executable" => changed[0].as_mut().unwrap().executable = false,
                "binary" => changed[1].as_mut().unwrap().data[45] ^= 1,
                _ => changed[1].as_mut().unwrap().data.push(0),
            }
            assert!(
                verify_accounts(&pin, &changed, slot, slot, true).is_err(),
                "{case}"
            );
        }
        let mut headers = accounts;
        for account in headers.iter_mut().flatten() {
            account.data.truncate(45);
        }
        verify_accounts(&pin, &headers, slot, slot, false).unwrap();
        assert!(verify_accounts(&pin, &headers, slot - 1, slot, false).is_err());
        headers[1].as_mut().unwrap().data[13] ^= 1;
        assert!(verify_accounts(&pin, &headers, slot, slot, false).is_err());
    }
    #[test]
    fn release_window_excludes_upgrade_slot_and_unattested_future() {
        assert!(Attestation::default().window().is_err());
        let window = DeploymentWindow {
            first_slot: 20,
            through_slot: 30,
        };
        assert!(window.require_slot(19).is_err());
        window.require_slot(20).unwrap();
        window.require_slot(30).unwrap();
        assert!(window.require_slot(31).is_err());
    }
}
