class DomainError(Exception):
    """Business-rule violation (maps to HTTP 409/400)."""


class NotFound(DomainError):
    """Missing entity (maps to HTTP 404)."""


class Forbidden(DomainError):
    """Role/permission failure, e.g. a clerk confirming a deposit (403)."""


CONFLICT_RESOURCES = ("court", "machine", "battery", "basket")


class ResourceConflict(DomainError):
    def __init__(self, message: str, resource: str = "resource", conflicting: int | None = None):
        super().__init__(message)
        self.resource = resource
        self.conflicting = conflicting
