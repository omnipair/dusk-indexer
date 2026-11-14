#!/usr/bin/env python3
"""Deterministic baseline; variable traffic/log/backup usage is not forecast."""
import json
from decimal import Decimal
from pathlib import Path

root = Path(__file__).resolve().parents[1]
rates = json.loads((root / 'pricing-20261115.json').read_text())['rates']
parity = json.loads((root.parent / 'railway-parity.json').read_text())
D = Decimal
hours = D(730)
rate = lambda name: D(rates[name]['usd'])
primary_cpu = primary_memory = west_cpu = west_memory = D(0)
for service in parity['services']:
    if service['name'] == 'timescaledb':
        continue
    size = parity['sizing']['services'][service['name']]
    cpu, memory = D(str(size['vcpu'])), D(str(size['memoryGiB']))
    if service['name'] == 'dusk-indexer':
        west_cpu += cpu
        west_memory += memory
    else:
        primary_cpu += cpu
        primary_memory += memory
rows = {
    'Database c7i.2xlarge': rate('databaseHour') * hours,
    'Singapore Fargate services': (primary_cpu * rate('singaporeCpuHour') + primary_memory * rate('singaporeMemoryGiBHour')) * hours,
    'Oregon Fargate indexer': (west_cpu * rate('oregonCpuHour') + west_memory * rate('oregonMemoryGiBHour')) * hours,
    'One Singapore NAT gateway, hourly only': rate('natHour') * hours,
    'One Singapore ALB, hourly only': rate('albHour') * hours,
    'Minimum four public IPv4 addresses': 4 * rate('ipv4Hour') * hours,
    '70 GiB encrypted gp3, root plus data': 70 * rate('gp3GiBMonth'),
    '16 Secrets Manager secrets': 16 * D('.40'),
    'Five existing KMS keys, storage only': D(5),
    'Two private DNS zones': D(1),
}
for name, value in rows.items():
    print(f'{name}: ${value:.2f}')
print(f'Baseline subtotal: ${sum(rows.values()):.2f}/month')
print('Excluded: backup/S3/ECR storage, logs/alarms/custom metrics, API calls, KMS signing, ALB LCUs, NAT processing, inter-AZ/inter-region/internet transfer, transient rolling tasks, certificates, taxes, Vercel and existing Helius.')
