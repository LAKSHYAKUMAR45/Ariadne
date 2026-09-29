"""Synthetic topology builder for connected devices."""


class JCNRTopology:
    def __init__(self):
        self.devices = []
        self.links = []

    def add_device(self, device):
        self.devices.append(device)

    def construct_topology(self):
        for index, device in enumerate(self.devices[:-1]):
            self.add_link(device, self.devices[index + 1])
        return {"devices": self.devices, "links": self.links}

    def add_link(self, left, right):
        self.links.append((left, right))
