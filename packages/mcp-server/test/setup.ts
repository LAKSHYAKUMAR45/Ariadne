// Points the global cross-workspace registry (see @ariadne/core's
// Registry.ts) at an in-memory database instead of the real
// ~/.ariadne/registry.db for the duration of this package's test suite, so
// tests never touch (or depend on) the developer's / CI runner's actual
// home directory.
process.env.ARIADNE_REGISTRY_PATH = ':memory:';
