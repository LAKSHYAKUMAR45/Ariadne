"""JCNR device helpers."""

import os
from typing import Any
from fabric import Interface as JCNRFabricInterface

DEVICE_KIND = "leaf"


def logged(func):
    return func


class BaseDevice:
    """Base device type."""


@logged
class JCNRDevice(BaseDevice):
    """Represents a JCNR device."""

    role: str = DEVICE_KIND

    def __init__(self, hostname: str, metadata: dict[str, Any]) -> None:
        self.hostname = hostname
        self.metadata = metadata

    def connect(self, endpoint: str) -> None:
        """Connect to the fabric interface."""
        interface = JCNRFabricInterface(endpoint)
        self.metadata[endpoint] = interface
