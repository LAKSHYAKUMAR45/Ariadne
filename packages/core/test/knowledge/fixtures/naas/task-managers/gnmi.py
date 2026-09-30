"""Synthetic gNMI command-line options and endpoint construction."""


class GnmiFlags:
    def __init__(self, target, port=57400, tls=False):
        self.target = target
        self.port = port
        self.tls = tls


def build_gnmi_endpoint(flags):
    scheme = "grpcs" if flags.tls else "grpc"
    return f"{scheme}://{flags.target}:{flags.port}"
