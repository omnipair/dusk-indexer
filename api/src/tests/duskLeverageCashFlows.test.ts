import test from 'node:test';
import assert from 'node:assert/strict';
import { foldLeverageCashFlows, LeverageCashFlowEvent } from '../services/duskLeverageCashFlows';

const position = {address:'position',market:'market',openedSlot:100,marginRaw:'100',collateralRaw:'300',debtShares:'200'};
const payload = {position:'position',market:'market',owner:'owner',debt_asset_mint:'debt',collateral_asset_mint:'collateral',
  margin_amount:'100',collateral_amount:'300',debt_shares:'200'};
const opened: LeverageCashFlowEvent = {eventName:'LeveragePositionOpened',slot:100,payload};
const update = (slot: number, patch: Record<string,unknown> = {}): LeverageCashFlowEvent => ({eventName:'LeveragePositionUpdated',slot,
  payload:{...payload,owner_debit:'0',owner_credit:'0',...patch}});

test('repayment/additions are capital; withdrawals and size-only changes do not invent profit', () => {
  const rows = [opened,update(101,{owner_debit:'50',debt_shares:'150'}),
    update(102,{collateral_amount:'350'}),update(103,{owner_debit:'20',collateral_amount:'400'}),
    update(104,{owner_credit:'40',collateral_amount:'300',debt_shares:'150'})];
  const expected = {address:'position',market:'market',openedSlot:100,sourceSlot:110,status:'available',
    basis:'entry-margin-owner-flows.v1',contributedRaw:'170',withdrawnRaw:'40'};
  const current = {...position,debtShares:'150'};
  assert.deepEqual(foldLeverageCashFlows('owner',current,rows,110),expected);
  assert.deepEqual(foldLeverageCashFlows('owner',current,[...rows].reverse(),110),expected);
});

test('liquidation owner credits count, keeper rewards do not, and debt-free collateral retains its basis', () => {
  const state = {owner:'owner',closed:false,leverage_collateral_amount:'250',leverage_debt_shares:'0'};
  const rows = [opened,{eventName:'FlashLiquidationSettled',slot:101,payload:{market:'market',position:'position',leverage:true,
    owner_surplus:'1',position_state:{...state,leverage_collateral_amount:'280',leverage_debt_shares:'150'}}},
    {eventName:'EmergencyLiquidationSettled',slot:102,payload:{market:'market',position:'position',leverage:true,
      quote:{owner_credit:'2',reward_credit:'100'},position_state:state}}];
  const result = foldLeverageCashFlows('owner',{...position,collateralRaw:'250',debtShares:'0'},rows,110);
  assert.equal(result.status,'available');
  assert.equal('withdrawnRaw' in result && result.withdrawnRaw,'3');
});

test('missing/mismatched history never falls back to original margin as current cost basis', () => {
  for (const rows of [[],[update(101)],[opened,opened],[{...opened,payload:{...payload,margin_amount:'99'}}],
    [opened,update(101,{owner_debit:undefined})],[opened,update(101,{owner:'other'})],
    [opened,update(101,{collateral_amount:'299'})],[opened,update(111)],
    [opened,{eventName:'LeveragePositionClosed',slot:101,payload}]])
    assert.equal(foldLeverageCashFlows('owner',position,rows,110).status,'unavailable');
  assert.equal(foldLeverageCashFlows('owner',position,[opened],99).status,'unavailable');
});

test('a later reopened PDA excludes old-session payments', () => {
  const rows = [opened,update(101,{owner_debit:'500'}),{...opened,slot:200}];
  const result = foldLeverageCashFlows('owner',{...position,openedSlot:200},rows,210);
  assert.equal(result.status,'available');
  assert.equal('contributedRaw' in result && result.contributedRaw,'100');
});
