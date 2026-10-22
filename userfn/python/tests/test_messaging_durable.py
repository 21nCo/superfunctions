from userfn import UserFnClient, UserFnOptions
from userfn.types import Campaign, CampaignTrigger, CampaignCaps, MessageContent


def test_denied_priority_campaign_does_not_starve_lower_campaign(tmp_path, monkeypatch):
    client = UserFnClient(UserFnOptions('verified', endpoint='https://user.example', messaging_state_path=str(tmp_path / 'journal.json')))
    client.identify('local')
    client.set_campaigns([Campaign(id=id, priority=10-index, kind='modal', enabled=True,
        content=MessageContent(body=id), triggers=[CampaignTrigger(type='event')], caps=CampaignCaps(per_user=1))
        for index, id in enumerate(['high', 'low'])])
    requests = []
    def send(id, key, action):
        requests.append((id, action))
        return {'campaignId': id, 'allowed': id == 'low', 'shown': False}
    monkeypatch.setattr(client.durable_messaging, 'send', send)
    assert [campaign.id for campaign in client.trigger('event', 'show')] == ['low']
    assert requests == [('high', 'reserve'), ('low', 'reserve')]


def test_identity_change_during_durable_fence_never_hands_off_old_campaign(tmp_path, monkeypatch):
    client = UserFnClient(UserFnOptions('verified', endpoint='https://user.example', messaging_state_path=str(tmp_path / 'journal.json')))
    client.identify('local')
    client.set_campaigns([Campaign(id='campaign', kind='modal', enabled=True,
        content=MessageContent(body='private message'), triggers=[CampaignTrigger(type='event')])])
    monkeypatch.setattr(client.durable_messaging, 'send', lambda *args: {'campaignId': 'campaign', 'allowed': True, 'shown': False})
    save = client.durable_messaging.save
    def change_identity_during_save(journal):
        save(journal)
        if journal.get('campaign', {}).get('phase') == 'presenting':
            client.identify('other')
    monkeypatch.setattr(client.durable_messaging, 'save', change_identity_during_save)
    assert client.trigger('event', 'show') == []
    assert client.get_message_delivery_status() == {'campaign': 'uncertain'}
