import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Uri, Webview } from 'vscode';
import { chatHtml } from '../src/webview';

async function main(): Promise<void> {
  const root = resolve(__dirname, '../..');
  let html = '';
  const theme = ':root { --vscode-foreground:#d7dae0; --vscode-editor-background:#181a20; --vscode-input-background:#24272e; --vscode-input-foreground:#e1e4eb; --vscode-descriptionForeground:#969ba8; --vscode-button-background:#2956bd; --vscode-button-foreground:#fff; --vscode-focusBorder:#6092ff; --vscode-font-family:Segoe UI; --vscode-font-size:14px; --vscode-panel-border:#333740; } body { background:var(--vscode-editor-background); }';
  const server = createServer((request, response) => {
    const file = request.url === '/chat.js' ? 'chat.js' : request.url === '/chat.css' ? 'chat.css' : null;
    response.setHeader('Content-Type', file?.endsWith('.js') ? 'application/javascript' : file ? 'text/css' : 'text/html; charset=utf-8');
    if (file) void readFile(join(root, 'media', file), 'utf8').then(content => response.end(content + (file.endsWith('.css') ? '\n' + theme : ''))); else response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const webview = { cspSource: origin, asWebviewUri: (uri: Uri) => origin + uri.path } as unknown as Webview;
  html = chatHtml(webview, { path: '/chat.js' } as Uri, { path: '/chat.css' } as Uri, true, 'test-tab');
  const browser = await chromium.launch({ executablePath: process.env.COMPANION_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 850 }, colorScheme: 'dark' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.sent = []; window.acquireVsCodeApi = () => ({ getState: () => null, setState: value => { window.saved = value; }, postMessage: value => window.sent.push(value) });`);
    await page.goto(origin);
    const session = { status: 'idle', busy: false, items: [], prompts: [] };
    const post = (value: unknown) => page.evaluate(value => window.postMessage(value, '*'), value);
    await post({ type: 'state', session });
    await page.locator('#input').fill('Проверь проект');
    await page.locator('#send').click();
    assert.equal(await page.locator('#input').inputValue(), 'Проверь проект', 'retain draft until acknowledged');
    await post({ type: 'sent', text: 'Проверь проект' });
    await page.waitForFunction(() => (document.getElementById('input') as HTMLTextAreaElement).value === '');
    const sent = await page.evaluate('window.sent') as { type: string; text?: string }[];
    assert.equal(sent.filter(message => message.type === 'send').length, 1);
    const prompt = { id: 1, method: 'item/tool/requestUserInput', detail: '', questions: [{ id: 'choice', question: 'Как продолжить?', options: [{ label: 'Проверить тесты' }] }] };
    await post({ type: 'state', session: { ...session, status: 'waiting', turnId: 'turn', prompts: [prompt], items: [
      { id: 'u', role: 'user', title: '', text: 'Проверь проект' },
      { id: 'a', role: 'assistant', title: '', text: 'Тесты готовы. Какой следующий шаг?' },
      { id: 'tool', role: 'tool', title: 'commandExecution', text: 'npm test\n12 passed' },
      { id: 'xss', role: 'assistant', title: '', text: '<img src=x onerror="window.injected=true">' },
    ] } });
    await page.locator('.prompt input').fill('Мой ответ');
    assert.equal(await page.locator('img').count(), 0, 'model output is never parsed as HTML');
    assert.equal(await page.evaluate('window.injected'), undefined);
    await post({ type: 'state', session: { ...session, status: 'waiting', prompts: [prompt], items: [] } });
    assert.equal(await page.locator('.prompt input').inputValue(), 'Мой ответ', 'streaming updates retain typed answers');
    await page.getByRole('button', { name: 'Ответить', exact: true }).click();
    assert.ok((await page.evaluate('window.sent') as { type: string }[]).some(message => message.type === 'answer'));
    await post({ type: 'state', session: { ...session, status: 'done', items: [
      { id: 'u', role: 'user', title: '', text: 'Проверь проект и запусти тесты.' },
      { id: 'tool', role: 'tool', title: 'commandExecution', text: 'npm test\nВсе проверки пройдены.' },
      { id: 'a', role: 'assistant', title: '', text: 'Проверка завершена. Вкладки, восстановление состояния и обработка запросов работают.' },
    ] } });
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Выполнено');
    assert.equal(await page.locator('#messages > article, #messages > details').count(), 3);
    await mkdir(join(root, '.artifacts'), { recursive: true });
    await page.screenshot({ path: join(root, '.artifacts/chat-preview.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Browser UI: PASS (send acknowledgement, safe text, persistent answer, prompt reply)');
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
