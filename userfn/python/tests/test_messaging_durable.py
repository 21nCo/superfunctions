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


def test_messaging_requires_https_unless_local_http_is_explicit(tmp_path):
    import pytest
    from userfn.core.messaging_http import HttpMessaging
    path = str(tmp_path / 'journal.json')
    with pytest.raises(ValueError, match='HTTPS'):
        HttpMessaging(UserFnOptions('secret', endpoint='http://127.0.0.1:4321', messaging_state_path=path))
    assert not (tmp_path / 'journal.json').exists()
    HttpMessaging(UserFnOptions('secret', endpoint='http://127.0.0.1:4321', messaging_state_path=path, messaging_allow_insecure_http=True))
    HttpMessaging(UserFnOptions('secret', endpoint='https://user.example', messaging_state_path=path))


def test_temporal_metadata_requires_durable_and_is_validated():
    import pytest
    from userfn.types import CampaignSchedule
    client=UserFnClient(UserFnOptions('unused'));client.identify('local')
    campaign=Campaign(id='campaign',kind='modal',enabled=True,content=MessageContent(body='timed'),triggers=[CampaignTrigger(type='event')],cooldown_ms=100)
    client.set_campaigns([campaign])
    with pytest.raises(Exception,match='durable'):client.trigger('event','show')
    for value in [-1,1.5,True]:
        campaign.cooldown_ms=value
        with pytest.raises(ValueError,match='cooldown'):client.set_campaigns([campaign])
    campaign.cooldown_ms=0;campaign.schedule=CampaignSchedule(start_at=10,end_at=10)
    with pytest.raises(ValueError,match='schedule'):client.set_campaigns([campaign])


def test_expiry_fenced_before_and_after_journal_write(tmp_path,monkeypatch):
    from userfn.core.messaging_http import HttpMessaging
    for during_save in [False,True]:
        client=HttpMessaging(UserFnOptions('verified',endpoint='https://user.example',messaging_state_path=str(tmp_path/str(during_save))))
        expired=[not during_save]
        monkeypatch.setattr('userfn.core.messaging_http.time.time',lambda:2 if expired[0] else 1)
        monkeypatch.setattr(client,'send',lambda *_args:{'campaignId':'campaign','allowed':True,'shown':False,'expiresAt':2000})
        save=client.save
        def record(journal):
            save(journal)
            if journal.get('campaign',{}).get('phase')=='presenting':expired[0]=True
        monkeypatch.setattr(client,'save',record)
        assert client.admit('campaign','local',lambda:True,True)=='handled'


def test_temporal_missing_expiry_keeps_pending_receipt(tmp_path,monkeypatch):
    import pytest
    from userfn.core.messaging_http import HttpMessaging
    client=HttpMessaging(UserFnOptions('verified',endpoint='https://user.example',messaging_state_path=str(tmp_path/'journal')))
    monkeypatch.setattr(client,'send',lambda *_args:{'campaignId':'campaign','allowed':True,'shown':False})
    with pytest.raises(Exception,match='reservation expiry'):client.admit('campaign','local',lambda:True,True)
    assert client.status()=={'campaign':'pending'}
