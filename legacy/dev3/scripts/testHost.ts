import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = resolve(__dirname, '../..');
  const base = join(root, '.artifacts', `host-${Date.now()}`);
  const userData = join(base, 'user-data');
  const workspace = join(base, 'workspace');
  const codexHome = join(base, 'codex-home');
  const driver = join(base, 'driver');
  await Promise.all([mkdir(join(userData, 'User'), { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(codexHome, { recursive: true })]);
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'codexCompanion.cliPath': process.env.CODEX_COMPANION_CLI,
    'codexCompanion.windowsNotifications': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
  }));
  await mkdir(driver, { recursive: true });
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'companion-test-driver', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.139.0' }, main: './index.js', activationEvents: ['onStartupFinished'], extensionDependencies: ['local-companion.codex-companion'] }));
  await writeFile(join(driver, 'index.js'), `exports.activate = async () => {
    let result;
    try { await require(${JSON.stringify(join(root, 'dist/test/host/index.js'))}).run(); result = { passed: true }; }
    catch (error) { result = { passed: false, error: String(error.stack || error) }; }
    require('node:fs').writeFileSync(process.env.COMPANION_TEST_REPORT, JSON.stringify(result));
    await require('vscode').commands.executeCommand('workbench.action.quit');
  };`);
  for (const stage of ['create', 'restore']) {
    const report = join(base, `${stage}.json`);
    const log = createWriteStream(join(base, `${stage}.log`));
    const child = spawn(process.env.CODEX_COMPANION_VSCODE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'), [workspace,
      '--user-data-dir', userData, '--extensions-dir', join(base, 'extensions'),
      `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${driver}`,
      '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    ], { windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome, COMPANION_TEST_STAGE: stage, COMPANION_TEST_REPORT: report }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log); child.stderr.pipe(log);
    const timeout = setTimeout(() => child.kill(), 45_000);
    try {
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
      const result = JSON.parse(await readFile(report, 'utf8')) as { passed: boolean; error?: string };
      if (!result.passed) throw new Error(result.error);
      console.log(`Extension-host ${stage}: PASS`);
    } finally { clearTimeout(timeout); log.end(); }
  }
  console.log(`Isolated test profile: ${base}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
