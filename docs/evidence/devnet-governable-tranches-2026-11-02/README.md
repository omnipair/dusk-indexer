# Governable tranche devnet activation

Dusk PR #64 merge commit `bd980852fa743be609896109307f4084732eddf7`
was built from a clean checkout and upgraded under the existing devnet program
IDs. The leverage delegate finalized at slot `517825628`; Dusk finalized at slot
`517844520`, making `517844521` the first slot for the complete revision.

Finalized ProgramData reads match the reviewed local release payloads. Dusk has
no allocation padding. The delegate's 1,395,752-byte payload is followed by
9,576 zero bytes in its 1,405,328-byte ProgramData allocation. Both published
Anchor IDLs match the candidate's raw and canonical hashes.

The upgrade authority remains
`FJWRK3XJeVD8njSvTFXyHwP2jkatvBqeVwcNAFe5zVfJ`. The explicit deployment
buffers were closed automatically. No existing wallet token metadata was
rewritten; the naming rules apply to newly initialized metadata.

See `deployment.json` for the exact signatures, slots, hashes and addresses.
