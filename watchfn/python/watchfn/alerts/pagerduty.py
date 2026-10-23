"""PagerDuty Events v2 encoding; no independent retry or persistence layer."""
from hashlib import sha256
import json


def route_key(channel):
    return sha256(channel['integrationKey'].encode('utf-8')).hexdigest()


def dedup_key(namespace, notification, metadata):
    value = [namespace, notification['alert']['id'], metadata['episode']]
    return 'watchfn:' + sha256(json.dumps(value, separators=(',', ':')).encode('utf-8')).hexdigest()


def request(namespace, notification, channel, metadata):
    action = {'triggered': 'trigger', 'acknowledged': 'acknowledge', 'resolved': 'resolve'}[notification['event']]
    body = {'routing_key': channel['integrationKey'], 'event_action': action,
            'dedup_key': dedup_key(namespace, notification, metadata)}
    if action == 'trigger':
        alert = notification['alert']
        body['payload'] = {'summary': alert['name'], 'source': namespace,
                           'severity': channel.get('severity', alert.get('severity', 'warning')),
                           'custom_details': {'alertId': alert['id'], 'description': alert.get('description', '')}}
    return body
