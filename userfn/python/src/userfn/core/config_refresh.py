"""Explicit serial background refresh with observable failures and awaitable stop."""
import asyncio
import time
from .config_http import ConfigRefreshError


class ConfigRefreshLoop:
    def __init__(self, refresh, cancel, interval):
        if type(interval) is not int or not 100 <= interval <= 86400000:
            raise ValueError('Configuration refresh_interval must be 100–86400000 milliseconds')
        self.refresh, self.cancel, self.interval = refresh, cancel, interval
        self.task = None
        self.stopping = None
        self.state = {'running': False, 'consecutive_failures': 0}

    def status(self):
        return dict(self.state)

    def start(self):
        if self.stopping and not self.stopping.done():
            raise ConfigRefreshError('Await configuration refresh stop before restarting')
        if self.state['running']:
            return
        loop = asyncio.get_running_loop()
        self.state['running'] = True
        self.state['consecutive_failures'] = 0
        self.task = loop.create_task(self._run())
        self.task.add_done_callback(self._observe)

    @staticmethod
    def _observe(task):
        if not task.cancelled():
            task.exception()

    async def stop(self):
        if self.stopping and not self.stopping.done():
            return await asyncio.shield(self.stopping)
        # These mutations occur before any await, preventing another iteration.
        self.state['running'] = False
        self.state.pop('next_refresh_at', None)
        task = self.task
        if task:
            task.cancel()
        async def settle():
            await self.cancel()
            if task:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self.stopping = asyncio.create_task(settle())
        self.stopping.add_done_callback(self._observe)
        await asyncio.shield(self.stopping)

    async def _run(self):
        while self.state['running']:
            try:
                await self.refresh()
                if not self.state['running']:
                    return
                self.state['last_success_at'] = int(time.time() * 1000)
                self.state.pop('last_error', None)
                self.state['consecutive_failures'] = 0
            except asyncio.CancelledError:
                return
            except Exception as error:
                if not self.state['running']:
                    return
                self.state['last_error'] = str(error) if isinstance(error, ConfigRefreshError) else 'Configuration refresh failed'
                self.state['consecutive_failures'] += 1
            delay = min(self.interval * 2 ** min(self.state['consecutive_failures'], 10), max(self.interval, 300000))
            self.state['next_refresh_at'] = int(time.time() * 1000) + delay
            await asyncio.sleep(delay / 1000)
            self.state.pop('next_refresh_at', None)
