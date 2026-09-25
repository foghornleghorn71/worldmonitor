import { runBundle } from '../_bundle-runner.mjs';
await runBundle('test', [{"label":"HANG","script":"fixtures/_bundle-fixture-hang.mjs","intervalMs":1,"timeoutMs":3000}], {});
