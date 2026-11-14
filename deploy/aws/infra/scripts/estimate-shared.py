#!/usr/bin/env python3
"""Recompute the proposed shared ECS bill without AWS calls or provisioning."""
import json
from decimal import Decimal
from pathlib import Path

model_path = Path(__file__).resolve().parents[1] / 'shared-cost-estimate.json'
model = json.loads(model_path.read_text())
parity = json.loads((model_path.parent.parent / 'railway-parity.json').read_text())
assert sorted(model['preservedServices']) == sorted(s['name'] for s in parity['services'])
assert len(model['preservedServices']) == 14
assert len(set(model['signingProfiles'])) == 5
D = Decimal
rates = {name: D(rate['usd']) for name, rate in model['rates'].items()}
groups = {}
fixed = total = D(0)
for row in model['rows']:
    cost = D(row['quantity']) * rates[row['rate']]
    print(f"{row['name']}: ${cost:.2f}")
    total += cost
    if row['fixed']:
        fixed += cost
    groups[row['group']] = groups.get(row['group'], D(0)) + cost
print('\nGrouped monthly estimate:')
for name, cost in groups.items():
    print(f'{name}: ${cost:.2f}')
print(f'Fixed baseline: ${fixed:.2f}')
print(f'Variable usage and reserves: ${total - fixed:.2f}')
print(f'Estimated monthly total: ${total:.2f}')
print(f'First month, replacing $2 certificate reserve with $7 issuance: ${total - 2 + 7:.2f}')
print(f"Suggested planning amount: ${D(model['planningBudgetUsd']):.2f}; not a hard spending cap")
isolated_signers = 5 * D(model['monthlyHours']) * (
    D('.25') * rates['singaporeCpuHour'] + D('.5') * rates['singaporeMemoryGiBHour']
)
print(f'Optional Fargate isolation for the five signing workers: +${isolated_signers:.2f}; total ${total + isolated_signers:.2f}')
print('Estimate only. No AWS write or provisioning operation performed.')
