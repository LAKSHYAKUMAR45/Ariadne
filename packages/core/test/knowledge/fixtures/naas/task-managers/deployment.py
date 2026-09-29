"""Synthetic deployment install and uninstall verification."""


class DeploymentVerifier:
    def uninstall_deployment(self, runner, deployment):
        runner.run("uninstall", deployment)
        return self.verify_installation(runner, deployment, expected=False)

    def install_deployment(self, runner, deployment):
        runner.run("install", deployment)
        return self.verify_installation(runner, deployment, expected=True)

    def verify_installation(self, runner, deployment, expected):
        current = runner.is_installed(deployment)
        return current is expected
