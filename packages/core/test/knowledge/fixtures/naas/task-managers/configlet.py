"""Synthetic configlet application with bounded retry and cleanup."""


class ConfigletManager:
    def __init__(self, maximum_attempts=3):
        self.maximum_attempts = maximum_attempts
        self.applied = []

    def apply_configlet(self, device, configlet, push):
        for attempt in range(self.maximum_attempts):
            try:
                push(device, configlet)
                self.applied.append(configlet)
                return True
            except OSError:
                if attempt + 1 == self.maximum_attempts:
                    self.cleanup_configlet(configlet)
                    raise
        return False

    def cleanup_configlet(self, configlet):
        if configlet in self.applied:
            self.applied.remove(configlet)
