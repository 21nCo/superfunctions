"""Bounded survey submission with caller-owned idempotency and explicit receipts."""
from __future__ import annotations
import asyncio
import json
import re
from typing import List
from urllib.parse import urlsplit
from ..types import SurveyReceipt, SurveyResponseAnswer, UserFnOptions


class SurveyDeliveryError(Exception):
    def __init__(self, message: str, status: int | None = None):
        self.status = status
        super().__init__(message)


class HttpSurveyService:
    def __init__(self, options: UserFnOptions):
        endpoint = urlsplit(options.endpoint or '')
        if (endpoint.scheme not in ('http', 'https') or not endpoint.hostname
                or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
                or not options.api_key.strip()):
            raise ValueError('Invalid survey endpoint or credential')
        self.endpoint = (options.endpoint or '').rstrip('/')
        self.key = options.api_key
        self.timeout = options.survey_timeout_ms
        self.attempts = options.survey_max_attempts
        if (type(self.timeout) is not int or not 1 <= self.timeout <= 60000
                or type(self.attempts) is not int or not 1 <= self.attempts <= 5):
            raise ValueError('Invalid survey timeout/retry configuration')

    async def submit(self, survey_id: str, answers: List[SurveyResponseAnswer], idempotency_key: str) -> SurveyReceipt:
        if (any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value) for value in (survey_id, idempotency_key))
                or not isinstance(answers, list) or len(answers) > 100
                or any(not isinstance(answer, SurveyResponseAnswer) for answer in answers)):
            raise ValueError('Invalid survey submission')
        body = json.dumps({'answers': [{'questionId': answer.question_id, 'value': answer.value} for answer in answers]}, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(body) > 65536:
            raise ValueError('Survey request exceeds 65536 bytes')
        try:
            import httpx
        except ImportError as error:
            raise SurveyDeliveryError('Install userfn[surveys] for survey HTTP submission') from error
        for attempt in range(self.attempts):
            try:
                return await asyncio.wait_for(self._request(survey_id, body, idempotency_key), self.timeout / 1000)
            except SurveyDeliveryError as error:
                if error.status is None or (error.status != 408 and error.status < 500) or attempt + 1 == self.attempts:
                    raise
            except (asyncio.TimeoutError, httpx.TransportError) as error:
                if attempt + 1 == self.attempts:
                    raise SurveyDeliveryError('Survey outcome is unknown; retry the same key') from error
            await asyncio.sleep(.1 * 2 ** attempt)
        raise SurveyDeliveryError('Survey outcome remains unknown; retry the same key')

    async def _request(self, survey_id: str, body: bytes, key: str) -> SurveyReceipt:
        import httpx
        async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=self.timeout / 1000) as client:
            async with client.stream('POST', self.endpoint + '/surveys/' + survey_id + '/responses', content=body,
                                     headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json', 'Idempotency-Key': key}) as response:
                if not 200 <= response.status_code < 300:
                    raise SurveyDeliveryError(f'Survey request failed with HTTP {response.status_code}', response.status_code)
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 65536:
                        raise SurveyDeliveryError('Oversized survey receipt')
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError) as error:
                    raise SurveyDeliveryError('Invalid survey receipt') from error
                if (not isinstance(value, dict) or value.get('accepted') is not True
                        or not isinstance(value.get('id'), str) or not re.fullmatch(r'[a-f0-9]{64}', value['id'])
                        or value.get('surveyId') != survey_id or type(value.get('submittedAt')) is not int
                        or not 0 <= value['submittedAt'] <= 8640000000000000):
                    raise SurveyDeliveryError('Invalid survey receipt')
                return SurveyReceipt(id=value['id'], survey_id=survey_id, submitted_at=value['submittedAt'], accepted=True)
