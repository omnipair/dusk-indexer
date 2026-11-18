import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETIREMENT_CLOSURE_POLICY, retirementMinimumNetPayout } from '../services/duskRetirementPolicy';
import { parseRetirementRpcJson } from '../services/duskRetirementBank';

test('retirement policy records the approved curve, fees and 1% net limit without authorizing a deployment',()=>{
  assert.equal(RETIREMENT_CLOSURE_POLICY.maximumNetPayoutSlippageBps,100);
  assert.equal(RETIREMENT_CLOSURE_POLICY.curve,'existing-market-curve');
  assert.equal(RETIREMENT_CLOSURE_POLICY.fees,'normal-protocol-fees');
  assert.equal(RETIREMENT_CLOSURE_POLICY.treasuryTopUp,false);
  assert.equal(RETIREMENT_CLOSURE_POLICY.residualRecipient,'8s6Jdoh7tgUqmU3D2EmpNJHSvuN5U4NybpLAdsiMitwB');
  assert.equal(RETIREMENT_CLOSURE_POLICY.residualAfterAllClaimsOnly,true);
  assert.equal(RETIREMENT_CLOSURE_POLICY.immediateJuniorTerminalSettlement,true);
  assert.equal(RETIREMENT_CLOSURE_POLICY.juniorExitFeeBps,50);
  assert.deepEqual(RETIREMENT_CLOSURE_POLICY.juniorTerminalRequires,
    ['frozen-market','zero-fixed-debt','zero-isolated-debt','zero-hlp-funding']);
  assert.equal(RETIREMENT_CLOSURE_POLICY.liveExecutionAuthorized,false);
});
test('net minimum rounds upward so tiny payouts cannot lose more than 1%',()=>{
  for(const [net,minimum] of [[0n,0n],[1n,1n],[99n,99n],[100n,99n],[101n,100n],[9999n,9900n],[10000n,9900n]])
    assert.equal(retirementMinimumNetPayout(net),minimum);
});
test('net limit remains exact at u64 maximum and rejects out-of-range entitlements',()=>{
  const maximum=(1n<<64n)-1n,minimum=retirementMinimumNetPayout(maximum);
  assert.ok(minimum*10000n>=maximum*9900n);
  assert.ok((minimum-1n)*10000n<maximum*9900n);
  assert.throws(()=>retirementMinimumNetPayout(-1n),/Invalid/);
  assert.throws(()=>retirementMinimumNetPayout(maximum+1n),/Invalid/);
});
test('bank JSON preserves exact u64 rentEpoch while keeping safe slots and lamports numeric',()=>{
  assert.deepEqual(parseRetirementRpcJson('{"context":{"slot":470788421},"account":{"lamports":2039280,"rentEpoch":18446744073709551615}}'),
    {context:{slot:470788421},account:{lamports:2039280,rentEpoch:'18446744073709551615'}});
});
test('malformed and overflowing rentEpoch values cannot become a valid frozen bank',()=>{
  for(const value of ['-1','1.5','18446744073709551616','"18446744073709551615"'])
    assert.throws(()=>parseRetirementRpcJson(`{"rentEpoch":${value}}`),/rent epoch/);
});
