"""Real SendFn SES delivery, with provider ownership retained through drain."""
import asyncio
from html import escape
from email.utils import formataddr


class EmailCleanupError(RuntimeError):
    """Client drain/cleanup did not complete successfully; never report clean stop."""


def configuration(value):
    try:
        import boto3  # noqa: F401
        from sendfn.models import EmailConfig, AwsSesConfig
        from sendfn.email.aws_ses import AwsSesProvider
    except ImportError:
        raise ValueError('Install watchfn[email] and the documented SendFn SES prerequisite') from None
    if ('read_timeout' not in AwsSesConfig.model_fields
            or not hasattr(AwsSesProvider, 'pending_operations')):
        raise ValueError('SendFn SES operation-ownership prerequisite is required')
    try:
        result = EmailConfig.model_validate(value.model_dump() if isinstance(value, EmailConfig) else value).model_copy(deep=True)
        if result.aws_ses is None: raise ValueError()
        if any(chr(10) in str(item) or chr(13) in str(item) for item in (result.from_name or '', result.from_email, result.reply_to or '')):
            raise ValueError()
        return result
    except Exception:
        raise ValueError('Invalid trusted SES email configuration') from None


def recipients(channel):
    from pydantic import EmailStr, TypeAdapter
    try:
        return [str(address) for address in TypeAdapter(list[EmailStr]).validate_python(channel['recipients'])]
    except Exception:
        raise ValueError('Invalid email recipients') from None


async def send(config, notification, channel):
    from sendfn.email.aws_ses import AwsSesProvider
    from sendfn.email.provider import SendEmailRequest
    provider = AwsSesProvider(config.aws_ses)
    alert = notification['alert']
    subject = f"[{alert.get('severity', 'warning')}] {alert['name']}: {notification['event']}"
    # Alert content is untrusted text; never inject it as HTML or header lines.
    subject = subject.replace('\r', ' ').replace('\n', ' ')[:500]
    body = f"{subject}\n{alert.get('description', '')}\nAlert: {alert['id']}\nNotification: {notification['id']}"
    try:
        response = await provider.send_email(SendEmailRequest(
            from_email=formataddr((config.from_name, str(config.from_email))) if config.from_name else str(config.from_email),
            to=recipients(channel), subject=subject, html=f'<pre>{escape(body)}</pre>', text=body,
            reply_to=str(config.reply_to) if config.reply_to else None,
        ))
        # SDK acceptance is not proof of inbox delivery. Never retry a failed SES
        # response automatically: SendFn's generic error mapping is not a proof
        # that a timed-out/failed request was not accepted.
        return 'delivered' if response.success and response.provider_message_id else 'unknown'
    except Exception:
        return 'unknown'
    finally:
        # wait_for cancellation arrives here; keep the owner operation/loop alive
        # until the shielded SDK work actually settles, even beyond its deadline.
        drain = asyncio.create_task(provider.close())
        cancelled = False
        while not drain.done():
            try:
                await asyncio.shield(drain)
            except asyncio.CancelledError:
                # A timeout can arrive during close itself, not just during send.
                # Do not abandon that retained drain or let storage stop its loop.
                cancelled = True
            except Exception:
                break
        if drain.cancelled() or drain.exception() is not None:
            raise EmailCleanupError('SES provider cleanup incomplete') from None
        if cancelled:
            raise asyncio.CancelledError()
