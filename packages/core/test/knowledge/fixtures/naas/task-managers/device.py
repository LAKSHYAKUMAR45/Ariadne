"""Small synthetic fixture for fabric-backed device setup."""


class JCNRDevice:
    def __init__(self, hostname):
        self.hostname = hostname
        self.interfaces = []

    def add_fabric_interface(self, name, address):
        interface = {"name": name, "address": address}
        self.interfaces.append(interface)
        return interface
