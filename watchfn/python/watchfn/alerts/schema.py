"""Watch-owned shared-adapter schemas, matching TS alert JSON-text storage."""
from superfunctions.db import FieldSchema, TableSchema, IndexSchema

ALERTS = 'watchfn_alerts'
OUTBOX = 'watchfn_alert_outbox'
RUNTIME = 'watchfn_alert_runtime'


def get_alert_schema():
    def table(name, strings, numbers):
        return TableSchema(name=name, fields=[
            FieldSchema(name='id', type='string', primary_key=True, unique=True),
            *[FieldSchema(name=key, type='string', nullable=key == 'leaseToken') for key in strings],
            *[FieldSchema(name=key, type='bigint') for key in numbers],
            FieldSchema(name='payload', type='text'),
        ])
    return {
        RUNTIME: TableSchema(name=RUNTIME, fields=[FieldSchema(name='id', type='string', primary_key=True, unique=True), FieldSchema(name='protocol', type='string'), FieldSchema(name='migrationPhase', type='string', nullable=True), FieldSchema(name='migrationCursor', type='string', nullable=True), FieldSchema(name='migrationRevision', type='bigint', nullable=True)]),
        ALERTS: TableSchema(name=ALERTS, fields=table(ALERTS, ['namespace', 'state'], ['revision']).fields, indexes=[IndexSchema(name='watchfn_alert_namespace', fields=['namespace', 'id'])]),
        OUTBOX: TableSchema(name=OUTBOX, fields=table(OUTBOX, ['namespace', 'alertId', 'state', 'leaseToken'], ['revision', 'availableAt', 'attempts']).fields + [FieldSchema(name='predecessorId', type='string', nullable=True), FieldSchema(name='completedAt', type='bigint', nullable=True)], indexes=[IndexSchema(name='watchfn_alert_dispatch', fields=['namespace', 'state', 'availableAt', 'id']), IndexSchema(name='watchfn_alert_receipts', fields=['namespace', 'completedAt', 'id']), IndexSchema(name='watchfn_alert_predecessor', fields=['namespace', 'predecessorId']), IndexSchema(name='watchfn_alert_jobs', fields=['namespace', 'id'])]),
    }
