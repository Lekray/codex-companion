import { spawn } from 'node:child_process';
import { createWriteStream, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const real = process.argv.includes('--real');
  const isolated = process.argv.includes('--isolated');
  const root = resolve(__dirname, '../..');
  const base = join(root, '.artifacts', `official-${real ? 'real' : 'fixture'}-${Date.now()}`);
  const workspace = join(base, 'workspace');
  await mkdir(workspace, { recursive: true });
  const roots = [realpathSync.native(workspace)];
  const key = createHash('sha256').update(JSON.stringify(roots.map(root => root.toLowerCase()))).digest('hex').slice(0, 32);
  const localAppData = join(base, 'local-app-data');
  const environment = join(localAppData, 'CodexCompanion', 'projects', key);
  const profile = join(environment, 'userdata');
  const codexHome = join(environment, 'codex-home');
  const driver = join(base, 'driver');
  const officialFixture = join(base, 'official-fixture');
  const report = join(base, 'report.json');
  await Promise.all([join(profile, 'User/globalStorage'), driver, officialFixture, codexHome].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(environment, 'companion-project.json'), JSON.stringify({ schemaVersion: 1, roots }));
  // This suite checks explicit clicks; first-launch auto-open has its own tests.
  const state = new DatabaseSync(join(profile, 'User/globalStorage/state.vscdb'));
  try {
    state.exec('CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    state.prepare('INSERT INTO ItemTable(key,value) VALUES (?,?)').run('local-companion.codex-companion',
      JSON.stringify({ ['codexCompanion.projectEnvironment.opened.' + key]: true }));
  } finally { state.close(); }
  await writeFile(join(workspace, 'app-server'), `const fs=require('fs'), readline=require('readline'); const rl=readline.createInterface({input:process.stdin}); rl.on('line',line=>{ const m=JSON.parse(line); fs.appendFileSync('quota-rpc.jsonl',JSON.stringify({method:m.method})+'\\n'); if(m.method==='initialized')return; const result=m.method==='initialize'?{userAgent:'quota-fixture'}:m.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:7,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}:null; process.stdout.write(JSON.stringify(result?{id:m.id,result}:{id:m.id,error:{code:-32601,message:'Forbidden fixture method'}})+'\\n'); }); rl.on('close',()=>process.exit(0));`);
  await writeFile(join(profile, 'User/settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
    'codexCompanion.cliPath': process.execPath, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  }));
  await writeFile(join(officialFixture, 'package.json'), JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: '0.0.1', engines: { vscode: '^1.139.0' }, main: './index.js', activationEvents: ['onStartupFinished'], contributes: { commands: [{ command: 'chatgpt.newCodexPanel', title: 'Official fixture panel' }] } }));
  await writeFile(join(officialFixture, 'index.js'), `exports.activate = context => { const vscode=require('vscode'); let opened=0; context.subscriptions.push(vscode.commands.registerCommand('chatgpt.newCodexPanel',()=>{opened++;})); return {opened:()=>opened}; };`);
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'official-companion-driver', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.139.0' }, main: './index.js', activationEvents: ['onStartupFinished'], extensionDependencies: ['local-companion.codex-companion'] }));
  await writeFile(join(driver, 'index.js'), `exports.activate = async () => { let result; try { result = await require(${JSON.stringify(join(root, 'dist/test/officialHost/index.js'))}).run(); } catch(error) {result={passed:false,error:String(error.stack||error)};} require('fs').writeFileSync(${JSON.stringify(report)},JSON.stringify(result)); await require('vscode').commands.executeCommand('workbench.action.quit'); };`);
  const official = real ? process.env.COMPANION_OFFICIAL_EXTENSION : officialFixture;
  if (!official) throw new Error('Set COMPANION_OFFICIAL_EXTENSION to the installed official extension path');
  const log = createWriteStream(join(base, 'vscode.log'));
  const child = spawn(process.env.CODEX_COMPANION_VSCODE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe'), [workspace,
    '--user-data-dir', profile, '--extensions-dir', join(base, 'extensions'),
    `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${official}`, `--extensionDevelopmentPath=${driver}`,
    '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--locale=en',
  ], { windowsHide: true, env: { ...process.env, LOCALAPPDATA: localAppData, CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome, CODEX_COMPANION_PROJECT_ID: isolated ? key : undefined,
    COMPANION_OFFICIAL_REAL: real ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
    const result = JSON.parse(await readFile(report, 'utf8')) as { passed: boolean; error?: string };
    if (!result.passed) throw new Error(result.error);
    console.log(JSON.stringify({ mode: real ? 'real official extension' : 'command fixture', ...result, artifacts: base }, null, 2));
  } finally { clearTimeout(timer); log.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
