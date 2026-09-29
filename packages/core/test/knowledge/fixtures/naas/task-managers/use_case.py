"""Synthetic use-case loading and failure teardown."""


class UseCaseLoader:
    def __init__(self, reader):
        self.reader = reader
        self.active = []

    def load_use_case(self, name):
        try:
            use_case = self.reader(name)
            self.active.append(use_case)
            return use_case
        except OSError:
            self.tear_down()
            raise

    def tear_down(self):
        self.active.clear()
