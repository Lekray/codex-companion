(() => {
  const vscode = acquireVsCodeApi();
  const { words, id } = window.companion;
  const $ = name => document.getElementById(name);
  const input = $('input');
  const old = vscode.getState();
  input.value = old?.id === id ? old.draft || '' : '';
  const save = () => vscode.setState({ id, draft: input.value });
  save();
  input.addEventListener('input', save);
  let busy = false;
  let sending = false;
  const nodes = new Map();
  const promptNodes = new Map();
  function send() {
    if (busy || sending || !input.value.trim()) return;
    sending = true;
    $('send').disabled = true;
    vscode.postMessage({ type: 'send', text: input.value });
  }
  $('composer').addEventListener('submit', event => { event.preventDefault(); send(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
  });
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  function button(label, onClick) {
    const node = document.createElement('button');
    node.textContent = label;
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'sent') {
      if (input.value === message.text) input.value = '';
      sending = false;
      save();
      $('send').disabled = busy;
      return;
    }
    if (message.type === 'sendFailed') { sending = false; $('send').disabled = busy; return; }
    if (message.type !== 'state') return;
    const state = message.session;
    busy = state.busy || !!state.turnId || state.status === 'running' || state.status === 'waiting';
    $('send').disabled = busy || sending;
    $('stop').disabled = !state.turnId;
    $('status').textContent = ({ running: words.working, waiting: words.waiting, done: words.done, error: words.error, idle: words.idle })[state.status];
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 100;
    $('empty')?.remove();
    const present = new Set();
    for (const item of state.items) {
      present.add(item.id);
      let node = nodes.get(item.id);
      if (!node) {
        node = document.createElement(item.role === 'tool' ? 'details' : 'article');
        node.className = item.role;
        const title = document.createElement(item.role === 'tool' ? 'summary' : 'h2');
        title.textContent = item.role === 'user' ? words.user : item.role === 'assistant' ? 'Codex' : item.title || words.tools;
        const content = document.createElement('pre');
        node.append(title, content);
        nodes.set(item.id, node);
        $('messages').appendChild(node);
      }
      const content = node.lastElementChild;
      if (content.textContent !== item.text) content.textContent = item.text;
    }
    for (const [key, node] of nodes) if (!present.has(key)) { node.remove(); nodes.delete(key); }
    const pending = new Set();
    for (const prompt of state.prompts) {
      pending.add(prompt.id);
      if (promptNodes.has(prompt.id)) continue;
      const card = document.createElement('section');
      card.className = 'prompt';
      const detail = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = ({ 'item/commandExecution/requestApproval': words.commandApproval, 'item/fileChange/requestApproval': words.fileApproval, 'item/permissions/requestApproval': words.permissionsApproval, 'item/tool/requestUserInput': words.inputPrompt })[prompt.method] || words.inputPrompt;
      detail.open = true;
      const text = document.createElement('pre');
      text.textContent = prompt.detail;
      detail.append(title, text);
      card.append(detail);
      const fields = new Map();
      for (const question of prompt.questions) {
        const label = document.createElement('label');
        label.textContent = question.question;
        const field = document.createElement('input');
        field.type = question.isSecret ? 'password' : 'text';
        label.append(field);
        card.append(label);
        fields.set(question.id, field);
        for (const option of question.options || []) {
          const choice = button(option.label, () => { field.value = option.label; });
          choice.title = option.description || '';
          card.append(choice);
        }
      }
      const answer = decision => {
        if (prompt.questions.some(q => !fields.get(q.id).value.trim())) return;
        const answers = Object.fromEntries([...fields].map(([key, field]) => [key, field.value]));
        vscode.postMessage({ type: 'answer', requestId: prompt.id, decision, answers });
      };
      if (prompt.questions.length) card.append(button(words.answer, () => answer('answer')));
      else card.append(button(words.allow, () => answer('accept')), button(words.deny, () => answer('decline')));
      promptNodes.set(prompt.id, card);
      $('prompts').appendChild(card);
    }
    for (const [key, node] of promptNodes) if (!pending.has(key)) { node.remove(); promptNodes.delete(key); }
    if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight);
  });
  vscode.postMessage({ type: 'ready' });
})();
