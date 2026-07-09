// Runs once before the whole test file's setup, for every test file in
// this package. Points the global cross-workspace registry (see
// `src/Registry.ts`) at an in-memory database instead of the real
// `~/.ariadne/registry.db`, so running the test suite never touches (or
// depends on) the developer's / CI runner's actual home directory.
process.env.ARIADNE_REGISTRY_PATH = ':memory:';
