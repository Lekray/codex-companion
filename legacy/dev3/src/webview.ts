import { randomBytes } from 'node:crypto';
import type { Webview, Uri } from 'vscode';

export function chatHtml(webview: Webview, script: Uri, style: Uri, russian: boolean, id: string): string {
  const nonce = randomBytes(24).toString('base64');
  const words = russian
    ? { send: 'Отправить', stop: 'Остановить', placeholder: 'Задача для Codex…', empty: 'Начните новый диалог', working: 'Работает', waiting: 'Ждёт ответа', done: 'Выполнено', error: 'Ошибка', idle: 'Готов', user: 'Вы', allow: 'Разрешить', deny: 'Отклонить', answer: 'Ответить', tools: 'Инструмент', commandApproval: 'Разрешить выполнение команды?', fileApproval: 'Разрешить изменение файлов?', permissionsApproval: 'Разрешить доступ до конца текущей задачи?', inputPrompt: 'Вопрос от Codex' }
    : { send: 'Send', stop: 'Stop', placeholder: 'Ask Codex…', empty: 'Start a new conversation', working: 'Working', waiting: 'Waiting for input', done: 'Completed', error: 'Error', idle: 'Ready', user: 'You', allow: 'Allow', deny: 'Decline', answer: 'Answer', tools: 'Tool', commandApproval: 'Allow this command?', fileApproval: 'Allow file changes?', permissionsApproval: 'Allow access for this turn?', inputPrompt: 'Question from Codex' };
  return `<!doctype html><html lang="${russian ? 'ru' : 'en'}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${webview.asWebviewUri(style)}">
<title>Codex</title></head><body>
<header><span id="status" role="status">${words.idle}</span></header>
<main id="messages" aria-label="${russian ? 'Диалог' : 'Conversation'}"><p id="empty">${words.empty}</p></main>
<section id="prompts" aria-live="polite"></section>
<form id="composer"><textarea id="input" rows="3" aria-label="${words.placeholder}" placeholder="${words.placeholder}"></textarea>
<div class="actions"><span class="hint">Ctrl+Enter</span><button id="stop" type="button" disabled>${words.stop}</button><button id="send" type="submit">${words.send}</button></div></form>
<script nonce="${nonce}">window.companion = ${JSON.stringify({ words, id }).replace(/</g, '\\u003c')};</script>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script></body></html>`;
}
