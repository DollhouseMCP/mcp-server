import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[2] / 'scripts/ci/export-tested-migration-image.py'
spec = importlib.util.spec_from_file_location('migration_export', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

BASE = [
    'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt', 'HOME=/home/dollhouse',
    'NODE_ENV=production', 'PERSONAS_DIR=/app/data/personas', 'NODE_OPTIONS=--max-old-space-size=256',
    'DOLLHOUSE_DISABLE_UPDATES=true', 'DOLLHOUSE_SECURITY_MODE=strict',
    'PATH=/app/node_modules/.bin:/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
]
REGULAR = BASE + ['DOLLHOUSE_PORTFOLIO_DIR=/app/tmp/portfolio', 'DOLLHOUSE_CACHE_DIR=/app/tmp/cache']


class MigrationEnvironmentTest(unittest.TestCase):
    def test_exact_role_environments(self):
        module.validate_environment({'Env': REGULAR}, 'migration')
        module.validate_environment({'Env': BASE}, 'prebuilt-migration')

    def test_refuses_extra_duplicate_and_wrong_role(self):
        for env, role in [(BASE + ['UNEXPECTED=value'], 'prebuilt-migration'),
                          (BASE + [BASE[0]], 'prebuilt-migration'), (BASE, 'migration'),
                          (REGULAR, 'prebuilt-migration')]:
            with self.subTest(role=role, env=env), self.assertRaises(SystemExit):
                module.validate_environment({'Env': env}, role)


if __name__ == '__main__':
    unittest.main()
