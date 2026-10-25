import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Browser, Frame, Locator, Page } from 'playwright-core';

// Diagnostic-only harness. It opens three official conversation-editor routes in an
// isolated VS Code profile, captures the official webview DOM/screenshots, and never
// sends a model message, starts/resumes a task, or opens an existing thread.
// Required: COMPANION_OFFICIAL_EXTENSION.
// Optional: COMPANION_AUTHENTICATED_PROBE_HOME (CODEX_HOME in place),
// COMPANION_PROJECT_HISTORY_WORKSPACE (absolute existing read-only folder),

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 200; i++) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await pause(100);
  }
  const suffix = lastError == null ? '' : `: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  throw new Error(`${message}${suffix}`);
}

interface RouteSpec {
  name: string;
  path: string;
  query: string;
}

interface DriverState {
  ready: boolean;
  projectId: string | null;
  workspaceFolders: string[];
  uriStringFallbackProjectId: string | null;
  routes: RouteSpec[];
  officialTabs: number;
  customTabs: number;
  active: { viewType: string; uri: string } | null;
  lastOpenedIndex: number | null;
  lastRoute: RouteSpec | null;
  lastError: string | null;
}

interface DomButton {
  text: string;
  ariaLabel: string | null;
  title: string | null;
}

interface DomLink {
  text: string;
  href: string;
}

interface FrameSnapshot {
  url: string;
  text: string;
  buttons: DomButton[];
  links: DomLink[];
  counts: { buttons: number; links: number; dialogs: number };
}

interface ReadyResult {
  ready: boolean;
  composer: boolean;
  projectUi: boolean;
  signIn: boolean;
  frames: number;
}

interface HistoryResult {
  triggerFound: boolean;
  triggerClicked: boolean;
  menuCaptured: boolean;
  viewAllFound: boolean;
  viewAllClicked: boolean;
  modalCaptured: boolean;
  dialogCount: number;
  menuArtifact: string | null;
  modalArtifact: string | null;
  menuScreenshot: string | null;
  modalScreenshot: string | null;
  notes: string[];
}

interface RouteReport {
  route: string;
  projectId: string | null;
  path: string;
  ready: ReadyResult;
  frames: number;
  buttons: number;
  links: number;
  dom: string;
  screenshot: string;
  history: HistoryResult;
}

async function readState(path: string): Promise<DriverState | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as DriverState;
  } catch {
    return undefined;
  }
}

async function visibleFrames(page: Page): Promise<Frame[]> {
  const result: Frame[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const element = await frame.frameElement();
      if (await element.isVisible()) result.push(frame);
    } catch {}
  }
  return result;
}

async function dismissAnnouncement(frame: Frame): Promise<boolean> {
  let dismissed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const announcement = frame.getByRole('dialog').filter({ hasText: /Introducing (?:GPT|Fast mode)/ }).first();
    if (!await announcement.isVisible().catch(() => false)) break;
    await announcement.getByRole('button', { name: 'Close', exact: true }).click();
    dismissed = true;
    await pause(400);
  }
  return dismissed;
}

async function waitForOfficialReady(page: Page): Promise<ReadyResult> {
  const deadline = Date.now() + 30_000;
  let composer = false;
  let projectUi = false;
  let signIn = false;
  let frames = 0;
  while (Date.now() < deadline) {
    const visible = await visibleFrames(page);
    frames = visible.length;
    composer = false;
    projectUi = false;
    signIn = false;
    for (const frame of visible) {
      await dismissAnnouncement(frame);
      if (!composer) {
        composer = await frame.locator('[contenteditable="true"]').first().isVisible().catch(() => false);
      }
      if (!signIn) {
        signIn = await frame.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).isVisible().catch(() => false);
      }
      if (!projectUi) {
        const text = await frame.locator('body').innerText().catch(() => '');
        projectUi = /Recent chats|New chat|Start new chat|What can I help|Codex/.test(text);
      }
      if (composer || projectUi || signIn) break;
    }
    if (composer || projectUi || signIn) return { ready: true, composer, projectUi, signIn, frames };
    await pause(500);
  }
  return { ready: false, composer, projectUi, signIn, frames };
}

async function captureVisibleFrames(page: Page): Promise<FrameSnapshot[]> {
  const snapshots: FrameSnapshot[] = [];
  for (const frame of await visibleFrames(page)) {
    const text = await frame.locator('body').innerText().catch(() => '');
    const buttons = await frame
      .locator('button, [role="button"]')
      .evaluateAll(nodes =>
        nodes.map(node => ({
          text: (node.textContent ?? '').trim().slice(0, 500),
          ariaLabel: node.getAttribute('aria-label'),
          title: node.getAttribute('title'),
        })),
      )
      .catch(() => [] as DomButton[]);
    const links = await frame
      .locator('a[href]')
      .evaluateAll(nodes =>
        nodes.map(node => ({
          text: (node.textContent ?? '').trim().slice(0, 500),
          href: node.getAttribute('href') ?? '',
        })),
      )
      .catch(() => [] as DomLink[]);
    const dialogs = await frame
      .locator('[role="dialog"], [data-radix-popper-content-wrapper], [data-command-menu]')
      .count()
      .catch(() => 0);
    snapshots.push({
      url: frame.url(),
      text,
      buttons,
      links,
      counts: { buttons: buttons.length, links: links.length, dialogs },
    });
  }
  return snapshots;
}

async function findRecentChatsTrigger(page: Page): Promise<{ frame: Frame; locator: Locator } | null> {
  for (const frame of await visibleFrames(page)) {
    const candidates = [
      frame.locator('button[aria-label^="Recent chats."]'),
      frame.getByRole('button', { name: /^Recent chats\./ }),
      frame.getByRole('button', { name: 'Recent chats', exact: true }),
    ];
    for (const candidate of candidates) {
      if ((await candidate.count().catch(() => 0)) > 0 && await candidate.first().isVisible().catch(() => false)) {
        return { frame, locator: candidate.first() };
      }
    }
  }
  return null;
}

async function waitForRecentChatsTrigger(page: Page, timeoutMs = 8_000): Promise<{ frame: Frame; locator: Locator } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const trigger = await findRecentChatsTrigger(page);
    if (trigger != null) return trigger;
    await pause(500);
  }
  return null;
}

async function waitForViewAll(page: Page, timeoutMs = 8_000): Promise<{ frame: Frame; locator: Locator } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of await visibleFrames(page)) {
      const candidates = [
        frame.getByRole('button', { name: /^View all \(\d+\)$/ }),
        frame.locator('button', { hasText: /^View all \(\d+\)$/ }),
      ];
      for (const candidate of candidates) {
        if ((await candidate.count().catch(() => 0)) > 0 && await candidate.first().isVisible().catch(() => false)) {
          return { frame, locator: candidate.first() };
        }
      }
    }
    await pause(500);
  }
  return null;
}

async function probeHistory(page: Page, base: string, index: number, routeName: string): Promise<HistoryResult> {
  for (const frame of await visibleFrames(page)) await dismissAnnouncement(frame);
  const result: HistoryResult = {
    triggerFound: false,
    triggerClicked: false,
    menuCaptured: false,
    viewAllFound: false,
    viewAllClicked: false,
    modalCaptured: false,
    dialogCount: 0,
    menuArtifact: null,
    modalArtifact: null,
    menuScreenshot: null,
    modalScreenshot: null,
    notes: [],
  };
  const trigger = await waitForRecentChatsTrigger(page);
  if (!trigger) {
    result.notes.push('No visible unambiguous Recent chats trigger was found.');
    return result;
  }
  result.triggerFound = true;
  try { await trigger.locator.click(); }
  catch { result.notes.push('Recent chats control could not be clicked.'); return result; }
  result.triggerClicked = true;
  await pause(1_000);

  // Recent chats itself is the full scrollable history popover in this build.
  // Capture it even when there is no second "View all" control inside it.
  const openedMenu = await captureVisibleFrames(page);
  result.menuArtifact = join(base, `history-opened-${index}.json`);
  await writeFile(result.menuArtifact, JSON.stringify({ route: routeName, frames: openedMenu }, null, 2));
  result.menuCaptured = true;
  const filter = trigger.frame.getByRole('button', { name: 'All chats', exact: true });
  if (await filter.isVisible().catch(() => false)) {
    await filter.click();
    await pause(250);
    await writeFile(join(base, `history-filter-${index}.json`), JSON.stringify({ frames: await captureVisibleFrames(page) }, null, 2));
    await trigger.frame.locator('body').press('Escape');
  }

  const viewAll = await waitForViewAll(page);
  result.viewAllFound = viewAll != null;

  if (viewAll == null) {
    result.notes.push('No visible View all (N) history control appeared after opening Recent chats.');
  } else {
    const menu = await captureVisibleFrames(page);
    const menuArtifact = join(base, `history-menu-${index}.json`);
    await writeFile(menuArtifact, JSON.stringify({ route: routeName, phase: 'menu', frames: menu }, null, 2));
    result.menuCaptured = true;
    result.menuArtifact = menuArtifact;
    const menuScreenshot = join(base, `history-menu-${index}.png`);
    await page.screenshot({ path: menuScreenshot }).catch(() => {});
    result.menuScreenshot = menuScreenshot;

    try { await viewAll.locator.click(); }
    catch { result.notes.push('View all control could not be clicked.'); return result; }
    result.viewAllClicked = true;
    await pause(1_500);

    const modal = await captureVisibleFrames(page);
    let dialogCount = 0;
    for (const snapshot of modal) dialogCount += snapshot.counts.dialogs;
    result.dialogCount = dialogCount;
    const modalArtifact = join(base, `history-modal-${index}.json`);
    await writeFile(modalArtifact, JSON.stringify({ route: routeName, phase: 'modal', dialogCount, frames: modal }, null, 2));
    result.modalCaptured = true;
    result.modalArtifact = modalArtifact;
    const modalScreenshot = join(base, `history-modal-${index}.png`);
    await page.screenshot({ path: modalScreenshot }).catch(() => {});
    result.modalScreenshot = modalScreenshot;
  }

  // Close the history popover/modal without ever activating an existing thread.
  await page.keyboard.press('Escape').catch(() => {});
  await pause(250);
  await page.keyboard.press('Escape').catch(() => {});
  return result;
}

async function openRoute(page: Page, statePath: string, requestPath: string, index: number, name: string): Promise<void> {
  await writeFile(requestPath, JSON.stringify({ index, nonce: Date.now() }));
  await until(async () => {
    const state = await readState(statePath);
    return state?.lastOpenedIndex === index && state.lastRoute?.name === name && (state.officialTabs ?? 0) > 0;
  }, `Route ${index} did not open`);
}

async function closeOfficialEditors(page: Page, statePath: string, requestPath: string): Promise<void> {
  await writeFile(requestPath, JSON.stringify({ action: 'close', nonce: Date.now() }));
  await until(async () => (await readState(statePath))?.officialTabs === 0, 'Official editor did not close');
  await pause(500);
}

async function resolveArtifactRoot(root: string): Promise<{ root: string; fallback: boolean }> {
  const preferred = join(root, '.artifacts', 'project-history-probe');
  await mkdir(preferred, { recursive: true });
  return { root: preferred, fallback: false };
}

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const official = process.env.COMPANION_OFFICIAL_EXTENSION;
  if (!official) throw new Error('Set COMPANION_OFFICIAL_EXTENSION to the installed official extension path');

  const root = resolve(__dirname, '../..');
  const runId = String(Date.now());
  const artifactRoot = await resolveArtifactRoot(root);
  const base = join(artifactRoot.root, runId);
  const profile = join(base, 'profile');
  const driver = join(base, 'driver');
  const statePath = join(base, 'driver-state.json');
  const requestPath = join(base, 'request.json');
  const configPath = join(base, 'driver-config.json');
  const authHome = process.env.COMPANION_AUTHENTICATED_PROBE_HOME;
  const codexHome = authHome ?? join(base, 'codex-home');
  const providedWorkspace = process.env.COMPANION_PROJECT_HISTORY_WORKSPACE;
  const tempRoot = join(base, 'tmp');
  process.env.TMP = tempRoot;
  process.env.TEMP = tempRoot;
  process.env.TMPDIR = tempRoot;

  let workspace: string;
  let workspaceKind: 'artifact' | 'provided';
  if (providedWorkspace != null) {
    if (!isAbsolute(providedWorkspace)) {
      throw new Error('COMPANION_PROJECT_HISTORY_WORKSPACE must be an absolute path');
    }
    workspace = resolve(providedWorkspace);
    const info = await stat(workspace).catch(() => undefined);
    if (info == null || !info.isDirectory()) {
      throw new Error('COMPANION_PROJECT_HISTORY_WORKSPACE must be an existing directory');
    }
    workspaceKind = 'provided';
  } else {
    workspace = join(base, 'workspace');
    workspaceKind = 'artifact';
  }

  await Promise.all([
    join(profile, 'User', 'globalStorage'),
    driver,
    tempRoot,
    ...(authHome == null ? [join(base, 'codex-home')] : []),
  ].map(path => mkdir(path, { recursive: true })));
  // Load Playwright only after TEMP/TMP point inside the artifact directory.
  // Playwright resolves os.tmpdir() when its module is evaluated.
  const { chromium } = await import('playwright-core');

  if (workspaceKind === 'artifact') {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'project-history-probe.txt'), 'Project history diagnostic workspace\n');
  }

  await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'codexCompanion.cliPath': process.execPath,
  }));

  // NUX flags are written only into the fresh isolated profile's globalStorage SQLite.
  const db = new DatabaseSync(join(profile, 'User', 'globalStorage', 'state.vscdb'));
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key,value) VALUES (?,?)').run('openai.chatgpt', JSON.stringify({
    'viewed2025-09-15-nux': true,
    'viewed2025-09-15-full-chatgpt-auth-nux': true,
  }));
  db.close();

  const officialPkg = JSON.parse(await readFile(join(official, 'package.json'), 'utf8')) as { version?: string };
  const officialVersion = officialPkg.version ?? null;
  await writeFile(configPath, JSON.stringify({ runId, includeProjectsRoute: true, routeNames: process.env.COMPANION_PROJECT_HISTORY_ROUTES?.split(',') }));
  await writeFile(requestPath, JSON.stringify({ index: -1 }));

  await writeFile(join(driver, 'package.json'), JSON.stringify({
    name: 'project-history-ui-driver',
    publisher: 'local-test',
    version: '0.0.1',
    engines: { vscode: '^1.139.0' },
    main: './index.js',
    activationEvents: ['onStartupFinished'],
    extensionDependencies: ['local-companion.codex-companion'],
    contributes: {
      commands: [
        { command: 'projectHistoryUi.openRequested', title: 'Open project history probe' },
        { command: 'projectHistoryUi.closeOfficialEditors', title: 'Close official editors' },
        { command: 'projectHistoryUi.quit', title: 'Quit diagnostic instance' },
      ],
      keybindings: [
        { command: 'projectHistoryUi.openRequested', key: 'ctrl+alt+f8' },
        { command: 'projectHistoryUi.closeOfficialEditors', key: 'ctrl+alt+f9' },
        { command: 'projectHistoryUi.quit', key: 'ctrl+alt+f10' },
      ],
    },
  }));

  const driverIndex = `const fs=require('fs'),crypto=require('crypto'),vscode=require('vscode');
const stateFile=${JSON.stringify(statePath)};
const configFile=${JSON.stringify(configPath)};
const requestFile=${JSON.stringify(requestPath)};
const folders=vscode.workspace.workspaceFolders??[];
const workspaceFolders=folders.map(f=>f.uri.fsPath);
const projectId=workspaceFolders.length?('vscode-'+crypto.createHash('sha256').update(workspaceFolders.join('\\0')).digest('hex').slice(0,32)):null;
const uriStringFallbackProjectId=folders.length?('vscode-'+crypto.createHash('sha256').update(folders.map(f=>f.uri.toString()).join('\\0')).digest('hex').slice(0,32)):null;
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const routes=[];
routes.push({name:'home-unscoped',path:'/',query:'companionHistoryProbe='+encodeURIComponent(config.runId+'-1')});
if(projectId){routes.push({name:'home-project-query',path:'/',query:'projectId='+encodeURIComponent(projectId)+'&hostId=local&companionHistoryProbe='+encodeURIComponent(config.runId+'-2')});}
if(projectId&&config.includeProjectsRoute){routes.push({name:'projects-project-route',path:'/projects',query:'projectId='+encodeURIComponent(projectId)+'&hostId=local&companionHistoryProbe='+encodeURIComponent(config.runId+'-3')});}
if(projectId&&config.includeProjectsRoute){routes.push({name:'projects-local-route',path:'/projects',query:'projectId='+encodeURIComponent(projectId)+'&companionHistoryProbe='+encodeURIComponent(config.runId+'-4')});}
if(config.routeNames?.length){routes.splice(0,routes.length,...routes.filter(route=>config.routeNames.includes(route.name)));}
let lastOpenedIndex=null,lastRoute=null,lastError=null;
const writeState=()=>{
  const tabs=vscode.window.tabGroups.all.flatMap(g=>g.tabs);
  const official=tabs.filter(t=>t.input instanceof vscode.TabInputCustom&&t.input.viewType==='chatgpt.conversationEditor');
  const custom=tabs.filter(t=>t.input instanceof vscode.TabInputWebview&&t.input.viewType.includes('codexCompanion.chat'));
  const active=vscode.window.tabGroups.activeTabGroup.activeTab;
  let activeInfo=null;
  if(active&&active.input instanceof vscode.TabInputCustom){activeInfo={viewType:active.input.viewType,uri:active.input.uri.toString()};}
  fs.writeFileSync(stateFile,JSON.stringify({ready:true,projectId,workspaceFolders,uriStringFallbackProjectId,routes,officialTabs:official.length,customTabs:custom.length,active:activeInfo,lastOpenedIndex,lastRoute,lastError},null,2));
};
exports.activate=async(context)=>{
  const companion=vscode.extensions.getExtension('local-companion.codex-companion');
  if(companion)await companion.activate();
  writeState();
  vscode.window.tabGroups.onDidChangeTabs(writeState);
  vscode.commands.registerCommand('projectHistoryUi.openRequested',async()=>{
    try{
      const request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
      if(request.action==='close'){await vscode.commands.executeCommand('projectHistoryUi.closeOfficialEditors');return;}
      if(request.action==='quit'){await vscode.commands.executeCommand('projectHistoryUi.quit');return;}
      if(request.index===-1)return;
      const route=routes[request.index];
      if(!route){lastError='route index out of range: '+request.index;writeState();return;}
      lastOpenedIndex=request.index;lastRoute=route;lastError=null;
      const resource=vscode.Uri.from({scheme:'openai-codex',authority:'route',path:route.path,query:route.query});
      await vscode.commands.executeCommand('vscode.openWith',resource,'chatgpt.conversationEditor',{preview:false});
    }catch(error){lastError=String(error&&error.stack||error);}
    writeState();
  });
  vscode.commands.registerCommand('projectHistoryUi.closeOfficialEditors',async()=>{
    const tabs=vscode.window.tabGroups.all.flatMap(g=>g.tabs).filter(t=>t.input instanceof vscode.TabInputCustom&&t.input.viewType==='chatgpt.conversationEditor');
    for(const tab of tabs){await vscode.window.tabGroups.close(tab,true);}
    writeState();
  });
  vscode.commands.registerCommand('projectHistoryUi.quit',async()=>{await vscode.commands.executeCommand('workbench.action.quit');});
  let lastRequest='',busy=false;
  const poll=setInterval(()=>{if(busy)return;let next;try{next=fs.readFileSync(requestFile,'utf8');JSON.parse(next);}catch{return;}if(next===lastRequest)return;lastRequest=next;busy=true;Promise.resolve(vscode.commands.executeCommand('projectHistoryUi.openRequested')).finally(()=>{busy=false;});},100);
  context.subscriptions.push({dispose:()=>clearInterval(poll)});
};
`;
  await writeFile(join(driver, 'index.js'), driverIndex);

  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));

  const log = createWriteStream(join(base, 'vscode.log'));
  const child = spawn(process.env.CODEX_COMPANION_VSCODE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe'), [
    workspace,
    '--user-data-dir', profile,
    '--extensions-dir', join(base, 'extensions'),
    `--extensionDevelopmentPath=${root}`,
    `--extensionDevelopmentPath=${official}`,
    `--extensionDevelopmentPath=${driver}`,
    `--remote-debugging-port=${port}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--locale=en',
  ], {
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const exited = new Promise<void>(resolvePromise => child.once('close', () => resolvePromise()));
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    await until(async () => {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      return true;
    }, 'No test debug endpoint');
    await until(async () => browser!.contexts().flatMap(context => context.pages()).some(candidate => candidate.url().includes('workbench')), 'No workbench page');
    page = browser!.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'))!;
    page.setDefaultTimeout(15_000);

    let state: DriverState | undefined;
    await until(async () => {
      state = await readState(statePath);
      return state?.ready === true;
    }, 'Driver extension did not initialize');
    const initial = state!;

    const routeReports: RouteReport[] = [];
    for (let index = 0; index < initial.routes.length; index++) {
      const route = initial.routes[index]!;
      await openRoute(page, statePath, requestPath, index, route.name);
      const ready = await waitForOfficialReady(page);
      await pause(route.name === 'home-unscoped' ? 2_000 : 3_000);
      const frames = await captureVisibleFrames(page);
      const screenshot = join(base, `route-${index + 1}.png`);
      await page.screenshot({ path: screenshot }).catch(() => {});
      const dom = join(base, `route-${index + 1}-dom.json`);
      await writeFile(dom, JSON.stringify({ route, ready, frames }, null, 2));
      const history = await probeHistory(page, base, index + 1, route.name);
      const totalButtons = frames.reduce((sum, frame) => sum + frame.counts.buttons, 0);
      const totalLinks = frames.reduce((sum, frame) => sum + frame.counts.links, 0);
      routeReports.push({
        route: route.name,
        projectId: initial.projectId,
        path: route.path,
        ready,
        frames: frames.length,
        buttons: totalButtons,
        links: totalLinks,
        dom,
        screenshot,
        history,
      });
      await closeOfficialEditors(page, statePath, requestPath);
    }

    const report = {
      runDir: base,
      artifactRootFallback: artifactRoot.fallback,
      officialVersion,
      workspaceKind,
      projectId: initial.projectId,
      codexHomeMode: authHome != null ? 'authenticated-in-place' : 'isolated',
      routes: routeReports,
      historySelectors: {
        trigger: 'button[aria-label^="Recent chats."]',
        viewAll: 'button with text /^View all \\(\\d+\\)$/',
        modal: 'uncertain: role=dialog, [data-radix-popper-content-wrapper], [data-command-menu]',
      },
      notes: [
        'No model message was sent, no task was started or resumed, and no existing thread was clicked.',
        'DOM text/buttons/links are stored only in the local artifact JSON files and are not printed.',
        workspaceKind === 'provided' ? 'The provided workspace was opened read-only; no fixture files were written into it.' : 'The default workspace is inside the artifact directory.',
        historySelectorsNote(),
      ],
    };
    await writeFile(join(base, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      runDir: base,
      artifactRootFallback: artifactRoot.fallback,
      officialVersion,
      workspaceKind,
      projectId: initial.projectId,
      routes: routeReports.map(route => ({
        route: route.route,
        projectId: route.projectId,
        frames: route.frames,
        buttons: route.buttons,
        links: route.links,
        history: {
          trigger: route.history.triggerFound,
          viewAll: route.history.viewAllFound,
          modal: route.history.modalCaptured,
          dialogs: route.history.dialogCount,
        },
        artifacts: [route.dom, route.screenshot, route.history.menuArtifact, route.history.modalArtifact],
      })),
    }, null, 2));
  } catch (error) {
    const failurePage = page ?? browser?.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'));
    await failurePage?.screenshot({ path: join(base, 'failure.png') }).catch(() => {});
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(join(base, 'failure.json'), JSON.stringify({ error: message, runDir: base }, null, 2)).catch(() => {});
    console.error(`Project history UI diagnostic failed. Artifacts: ${base}`);
    console.error(message);
    throw error;
  } finally {
    try {
      if (page != null && child.exitCode === null) {
        await writeFile(requestPath, JSON.stringify({ action: 'quit', nonce: Date.now() })).catch(() => {});
        await Promise.race([exited, pause(10_000)]);
      }
    } catch {}
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await exited;
    log.end();
  }
}

function historySelectorsNote(): string {
  return 'No scoping assertion is fabricated. The full-history modal selector is not stable in the shipped bundle; the harness captures role=dialog and Radix popper content and leaves interpretation to the root.';
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
