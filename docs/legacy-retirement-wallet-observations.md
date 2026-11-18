# Retirement rehearsal: separate SOL wallet observations

A larger claim catalog can exceed Solana's 100-account single-read limit when
plain wallet SOL accounts are included alongside the financial state. The
retirement tool now moves only the known beneficiaries' and payer's empty-data
System Program wallet accounts into a separately finalized `walletObservation`.

The single economic bank still contains every required protocol account,
receipt/asset mint, token balance, sysvar, and executable/ProgramData pin. Its
100-account bound, exact bank clock and both executable identity checks remain.
Token balances, debts, collateral, income epochs, receipt holders and program
state cannot be supplied through the wallet observation. If that economic bank
is itself too large, rehearsal stops rather than splitting it silently.

The wallet observation requires the exact bounded wallet catalog, a finalized
context at or after the economic bank, safe SOL integers, no executable code,
System Program ownership and empty account data. It cannot overlap the economic
bank. The local VM loads these observed lamports for fees/rent; it does not
mint tokens or invent wallet credits. The report includes the observation and
its hash, and explicitly does not claim one atomic bank across both reads.
Offline references and reconstructed cutoff models preserve the same evidence.

Loan rehearsal may first repay from that same owner's already-realized
protocol proceeds in the debt asset, before attempting collateral withdrawal.
This avoids a transient health violation when the owner already has the needed
repayment asset. Existing same-owner collateral-asset conversions remain.
Other owners' money, prior external wallet tokens, treasury top-ups and synthetic
token balances remain forbidden. Final token conservation, exhausted debt,
complete income/holder catalogs and reviewed net payouts remain mandatory.

This is an offline/read-only retirement preparation tool. It does not alter the
active pin, cursor, API identity, canonical event writes or any deployed state.
A new beneficiary requires a refreshed, reviewed on-chain retirement scope;
this change never authorizes dropping an extra claim or signing a transaction.
