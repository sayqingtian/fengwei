import { pathToFileURL } from 'node:url';

// EdgeOne schedules run at most daily. This bounded runner also runs hourly
// in GitHub Actions and follows the persisted cursor until cleanup is complete.
export async function cleanAudit({ url = 'https://www.wupanfeng.dpdns.org/api/maintenance/audit', send = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), maxBatches = 24, log = console.log } = {}) {
  let failures = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    try {
      const response = await send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(45000) });
      if (response.status === 429) { await pause(Math.max(65000, Number(response.headers.get('retry-after') || 0) * 1000)); continue; }
      if (!response.ok) throw new Error(`Cleanup HTTP ${response.status}`);
      const result = await response.json();
      if (result.ok !== true || typeof result.complete !== 'boolean') throw new Error('Unexpected cleanup response');
      failures = 0; log(result.complete ? 'Audit cleanup completed.' : 'Audit cleanup checkpoint saved; continuing.');
      if (result.complete) return;
    } catch (error) {
      if (++failures >= 3) throw error;
      log(`Cleanup attempt failed; retry ${failures}/3.`);
    }
    await pause(65000);
  }
  throw new Error('Cleanup still has pending records; next scheduled run will resume.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cleanAudit();
