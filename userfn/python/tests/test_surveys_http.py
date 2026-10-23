import asyncio
import json
import httpx
import pytest
from userfn import UserFnClient, UserFnOptions, SurveyResponseAnswer, SurveyDeliveryError

RECEIPT = {'id': 'a' * 64, 'surveyId': 's', 'submittedAt': 123, 'accepted': True}
ANSWERS = [SurveyResponseAnswer(question_id='q', value=5)]


def client(**options):
    return UserFnClient(UserFnOptions(api_key='credential', endpoint='https://service.example', survey_max_attempts=options.pop('survey_max_attempts', 1), **options))


def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def test_stable_retry_and_payload(monkeypatch):
    calls = []
    def respond(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectError('lost response')
        return httpx.Response(200, json=RECEIPT)
    transport(monkeypatch, respond)
    result = asyncio.run(client(survey_max_attempts=2).submit_survey_response('s', ANSWERS, idempotency_key='stable'))
    assert result.accepted and result.survey_id == 's'
    assert len(calls) == 2 and calls[0].content == calls[1].content
    assert calls[0].headers['idempotency-key'] == calls[1].headers['idempotency-key'] == 'stable'
    assert json.loads(calls[0].content) == {'answers': [{'questionId': 'q', 'value': 5}]}


@pytest.mark.parametrize('value', [{**RECEIPT, 'surveyId': 'other'}, {**RECEIPT, 'accepted': False}, {**RECEIPT, 'submittedAt': True}, {**RECEIPT, 'id': 'x'}, 'invalid'])
def test_invalid_receipt(monkeypatch, value):
    transport(monkeypatch, lambda request: httpx.Response(200, json=value))
    with pytest.raises(SurveyDeliveryError):
        asyncio.run(client().submit_survey_response('s', ANSWERS, idempotency_key='key'))


def test_oversized_receipt(monkeypatch):
    transport(monkeypatch, lambda request: httpx.Response(200, content=b'x' * 65537))
    with pytest.raises(SurveyDeliveryError, match='Oversized'):
        asyncio.run(client().submit_survey_response('s', ANSWERS, idempotency_key='key'))


@pytest.mark.parametrize('status', [302, 400, 403, 409, 429])
def test_terminal_status(monkeypatch, status):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(status)
    transport(monkeypatch, respond)
    with pytest.raises(SurveyDeliveryError) as raised:
        asyncio.run(client(survey_max_attempts=3).submit_survey_response('s', ANSWERS, idempotency_key='key'))
    assert raised.value.status == status and len(calls) == 1


def test_deadline(monkeypatch):
    async def stalled(request):
        await asyncio.sleep(10)
        return httpx.Response(200, json=RECEIPT)
    transport(monkeypatch, stalled)
    with pytest.raises(SurveyDeliveryError, match='unknown'):
        asyncio.run(client(survey_timeout_ms=10).submit_survey_response('s', ANSWERS, idempotency_key='key'))
