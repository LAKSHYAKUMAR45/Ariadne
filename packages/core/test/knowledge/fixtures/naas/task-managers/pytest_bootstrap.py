"""Synthetic pytest option defaults for task-manager tests."""


def pytest_addoption(parser):
    parser.addoption("--device-timeout", default=30)
    parser.addoption("--use-live-device", action="store_true", default=False)


def pytest_configure(config):
    timeout = config.getoption("--device-timeout")
    live = config.getoption("--use-live-device")
    config.task_manager_defaults = {"timeout": timeout, "live": live}
