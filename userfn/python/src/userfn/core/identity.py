from typing import Optional
from ..types import UserIdentity, UserTraits

class IdentityManager:
    def __init__(self):
        self.user: Optional[UserIdentity] = None

    def identify(self, id: str, traits: Optional[UserTraits] = None):
        if traits is None:
            traits = {}
        self.user = UserIdentity(id=id, traits=traits)

    def get_user(self) -> Optional[UserIdentity]:
        return self.user

    def reset(self):
        self.user = None
