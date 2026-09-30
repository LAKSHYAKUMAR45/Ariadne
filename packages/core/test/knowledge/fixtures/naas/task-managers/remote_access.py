"""Synthetic HBR credentials and SSH jump-host selection."""


class HbrCredentials:
    def __init__(self, username, password):
        self.username = username
        self.password = password


class HbrSession:
    def __init__(self, credentials, jump_hosts):
        self.credentials = credentials
        self.jump_hosts = jump_hosts

    def select_ssh_jump_host(self, region):
        return self.jump_hosts.get(region)

    def open_hbr_session(self, region):
        jump_host = self.select_ssh_jump_host(region)
        return {
            "username": self.credentials.username,
            "jump_host": jump_host,
        }
