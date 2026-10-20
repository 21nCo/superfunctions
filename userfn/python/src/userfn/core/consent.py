"""Application policy and an explicit forwarded DNT veto; no inferred server identity."""
from ..types import ConsentOptions


class ConsentPolicy:
    def __init__(self, options=None, do_not_track=False):
        if options is not None and not isinstance(options, ConsentOptions):
            raise ValueError('Consent must use ConsentOptions')
        if type(do_not_track) is not bool:
            raise ValueError('Forwarded DNT must be a boolean')
        self.analytics = True
        self.messaging = True
        self.do_not_track = False
        if options is not None:
            self.update(analytics=options.analytics, messaging=options.messaging)
        self.update(do_not_track=do_not_track)

    def update(self, *, analytics=None, messaging=None, do_not_track=None):
        for value in (analytics, messaging, do_not_track):
            if value is not None and type(value) is not bool:
                raise ValueError('Consent values must be booleans')
        if analytics is not None:
            self.analytics = analytics
        if messaging is not None:
            self.messaging = messaging
        if do_not_track is not None:
            self.do_not_track = do_not_track

    def state(self):
        return {'analytics': self.analytics and not self.do_not_track,
                'messaging': self.messaging and not self.do_not_track,
                'do_not_track': self.do_not_track}
