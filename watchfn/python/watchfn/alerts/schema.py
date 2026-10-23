"""Watch-owned shared-adapter schemas, matching TS alert JSON-text storage."""
from superfunctions.db import FieldSchema, TableSchema

ALERTS = 'watchfn_alerts'
OUTBOX = 'watchfn_alert_outbox'


def get_alert_schema():
    def table(name, strings, numbers):
        return TableSchema(name=name, fields=[
            FieldSchema(name='id', type='string', primary_key=True, unique=True),
            *[FieldSchema(name=key, type='string', nullable=key == 'leaseToken') for key in strings],
            *[FieldSchema(name=key, type='bigint') for key in numbers],
            FieldSchema(name='payload', type='text'),
        ])
    return {
        ALERTS: table(ALERTS, ['namespace', 'state'], ['revision']),
        OUTBOX: table(OUTBOX, ['namespace', 'alertId', 'state', 'leaseToken'], ['revision', 'availableAt', 'attempts']),
    }
