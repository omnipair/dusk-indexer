# Deployment-scoped SDK packaging

The Dusk source release is commit `c60160b` on PR #40; the program binary was built from its parent program source commit `5644e5d`. The currently deployed leverage delegate was not upgraded. At that commit, the SDK source also contains a newer delegate IDL and protection methods that are **not** deployed. Shipping that raw SDK would let clients build incompatible delegate instructions.

The vendored `@omnipair/dusk-sdk@2.10.2-devnet.20260927` archive was built in a temporary staging directory as follows:

1. Copy `packages/dusk-sdk` from PR #40 commit `c60160b` to an isolated staging directory.
2. Extract the previously reviewed `2.10.1-devnet.20260918` SDK tarball (SHA-256 `c1c4faf5079cf728d1a1e4f54e79c5675684e4e2c959af4594733c7ff00a0b08`). Copy its `src/idl_delegate.json` and `src/types_delegate.ts` over the staging copies. This retains the deployed delegate IDL (raw SHA-256 `b2d39d3575f72ad334a0f853784bdb5909ddead5e0ebf3dc84ccd5253eccdce3`).
3. Remove staging `src/protection.ts` and the protection export from `src/index.ts`. These methods require an undeployed delegate instruction.
4. Compile the staging SDK with `tsc` **without** rerunning `prepare-idl`, which would regenerate the newer undeployed delegate IDL. Pack with `npm pack --ignore-scripts`.
5. Verify the Dusk source IDL SHA-256 `5c2839cd1f022b9ab83cfbe135306f5efb3e4eb19a9abeac39fe0277d0c577d0`, packaged Dusk IDL SHA-256 `49594662c6b2af00ea9088f4d23374804020d94381890056212f5099800bfcce`, canonical Dusk IDL SHA-256 `72cfca415c1638045c46aef9e184b2e5280b3568bc5f61234bc03ce2081439d7`, and unchanged delegate IDL. Verify there is no `protection` export or file.

The exact archive in `api/vendor/` and in dusk-webapp `vendor/` is SHA-256 `bc2373ec73ec9b7fac654e0d64df951c63445bb3d0827ec902d437a5e13210e4`. Both consumers select it through their dependency lockfiles. The source SDK remains ahead of the deployed delegate until that program is separately upgraded.
