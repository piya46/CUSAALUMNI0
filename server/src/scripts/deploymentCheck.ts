import { fileURLToPath } from 'node:url';

try {
  const [{ config }, { checkDeployment }] = await Promise.all([import('../config.js'), import('../services/deploymentCheck.js')]);
  const report = await checkDeployment(config, fileURLToPath(new URL('../../../', import.meta.url)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch {
  // Zod/config errors may contain user-supplied values; never print them.
  console.error(JSON.stringify({ ok: false, code: 'DEPLOYMENT_CHECK_FAILED', message: 'Check the environment variable formats and deployment files; values are intentionally not printed.' }));
  process.exitCode = 1;
}
