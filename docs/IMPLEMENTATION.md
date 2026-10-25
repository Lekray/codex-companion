# Реализация Codex Companion

## 0.2.7 — тихое восстановление статусов (принято, локально установлено)

Область — только официальный OpenAI **26.1021.22027**. Слой 26.1007.21434
runtime/metadata побайтно прежний; прежние patch-build стадии, webviews и
pre-workflow не менялись. Source-level acceptance
`.artifacts/status-restore-027/accepted-source.json`: изменены только modern host
workflow/drafts (`out/extension.js`), остальные цели совпадают с прежними принятыми
байтами.

### Наблюдение thread/read

Новых RPC и второго App Server нет. Adapter `scripts/official261021.cjs`
встраивает в существующие пути четыре вызова: `__companionWorkflowTrackRead` при
отправке `thread/read`, `__companionWorkflowReadResponse` при получении ответа,
`__companionWorkflowForgetRead` при abandon/failed delivery и
`__companionWorkflowForgetWebviewReads` при dispose webview. Сам запрос и фильтрация
истории остаются native/webview.

`resources/officialTabStatusV2.js` хранит не более 64 записей чтения
(`__companionWorkflowMaxReads`), каждая привязана к thread, webview и
монотонному `requestSeq`; для потока хранится `lastHydratedReadSeq` и
`liveEpoch`. Ответ принимается, только если совпали request id/webview,
snapshot id, локальный hostId, `requestSeq` новее уже применённого и live epoch
не изменился. Любое live-событие потока увеличивает epoch и тем самым отменяет
ответы, начатые раньше. Дополнительно проверяются turn id/startedAt и признак
уже закрытого вопроса, поэтому поздний/переставленный снимок не перекрывает
более новый turn или terminal. Запись удаляется на ответ, ошибку, abandon,
failed delivery и dispose; thread pruning сохраняет активные/привязанные потоки.

### Статус из снимка

`__companionWorkflowHydrateRead`:

- `active` — `waiting` при `waitingOnApproval`/`waitingOnUserInput`, реальном
  pending request или вопросе; иначе `running`.
- `systemError` — `error` с очисткой ожиданий.
- Без полного `turns` (`includeTurns:false`) других переходов нет; idle/notLoaded
  не выдумывают turn.
- Полный `turns`: `inProgress` → running/waiting, `completed` → done,
  `failed` → error, `interrupted`/`cancelled`/`canceled` → idle.
- `completed` при незавершённой goal (`goalStatus != complete`) не даёт done:
  active остаётся running, остальные — waiting. Незавершённые вопросы также
  удерживают waiting и не дают ложного `[V]`.

Все переходы идут через `__companionWorkflowSetStatusSilent`, который публикует
`live:false`. `src/workflowUi.ts` принимает такой snapshot, обновляет название,
статус и счётчик через `onStatusEvent`, затем сразу выходит до `remembered`,
notice и sound. Реальные последующие события обрабатываются обычным live-путём.

### Вопросы и границы

Вопросы inProgress берутся из `agentMessage.questions` ограниченного размера.
Ответом считается только `userMessage` или принятое `steeringUserMessage` с
точным конвертом `<send_user_message_question_reply>…</send_user_message_question_reply>`
и JSON-полями
`questionItemId`/`question`/`answer`. Частичный ответ закрывает лишь указанные
вопросы; отклонённое steering и посторонний текст ничего не закрывают, лишние
вопросы не синтезируются.

Неразрешённые вопросы completed turn удерживают idle/прежнее waiting и не дают
ложного done. При отсутствующем `items`, `itemsView` не `full`, превышенных
лимитах и постраничных данных точное состояние вопросов неизвестно — это не
надёжное восстановление; completed без доступных items и без pending может
завершиться done. Изображения и история квот остаются backlog; следующая работа
по статусам — вопросы завершённых/постраничных turn.

Main: **426 passed, 0 failed/skipped** — .artifacts/status-restore-027/tests-main-tracked.log.
Живой синтетический UI/cold restart, package exact5/exact9 rollback/reinstall/no-op
и локальная установка приняты; детали — docs/HANDOFF.md, evidence —
.artifacts/status-restore-027/. Прежний engine 0.2.6 вернул исходные файлы OpenAI,
затем engine 0.2.7 установил новый слой. Backup сохранён по hash/mtime.
Другие клиенты не наблюдаются; сообщений модели, автоматического reload, polling,
resume и публикации нет.

## 0.2.4 — второй официальный билд

Старый слой 26.1007.21434 и его helpers/transforms/manifests/attestations
остаются побайтно прежними. Новый билд 26.1021.22027 подключается отдельно:
`scripts/official261021.cjs` — version-pinned adapter с проверенными anchors/SHA-256 оригиналов; `scripts/companionPatchEngine.cjs` — общая guarded factory
(preflight/locks/atomic/all-before-write/rollback); `scripts/companionPatches.cjs`
— публичный facade, выбирающий adapter по точной установленной identity.

Bundle map 26.1021 (schema 3, девять оригиналов): package.json (identity guard,
не переписывается), out/extension.js (history/startup/titles/model/status/
notifications) и семь webview chunks: src-622b307a9baf (history filter),
initialize-app-host-services.extension-f722db488e05 (history scope message),
local-conversation-page-e49199d4fdb5 (title reporter), message-bus-4113ba7287d7
(dispatch bridge), use-model-settings-aafcff4b111c (model select/set),
composer-content-8ab21f1a1982 (model restore/catalog), composer-scope-f0dbf0e746b6
(draft scope key). Metadata — `resources/patchBundleManifest-26.1021.22027.json` и
`resources/patchAttestation-26.1021.22027.json`.

Drafts: helper `resources/officialDraftIsolation.js` prefix в `composer-scope`;
UUID HOME text scope сохранён, native `homeDraftKey` project locking и
saved chats/models/send не меняются. `Fv`/`7a` и c014-архитектура относятся
только к 26.1007. Новых возможностей/провайдеров нет; quota UI 0.2.3 не меняется.

Установщик: новый backup
`%LOCALAPPDATA%/codex-companion/patches/26.1021.22027/chunks-v1`, full restore
возвращает все оригинальные цели; новый install не делает legacy adoption и не
трогает старый backup. Unknown/modified/mixed отказываются, locks/atomic/
all-before-write/stable-state/rollback сохраняются. Стандартные команды и CLI
прежние. Пакет предназначен `.artifacts/codex-companion-0.2.4.vsix`.

Модель: `resources/officialModel261021.js` инициализируется лениво, без
побочных действий на уровне ESM-модуля. Перехват штатного setter в `It` покрывает
меню и быстрый выбор; контекст берётся из ref при вызове. Неудачная новая попытка
не подавляет прежнюю успешную, старый успех не перезаписывает новый. HOME с
нативным managed draft допускается; блокировка модели политикой сохраняется.
Восстановление отдельно ждёт каталог, переживает rerender и уступает выбору
пользователя. `persistAsDefault:false` в обычном HOME обновляет нативный Qe/Ye
optimistic atom и очищает prewarm, не пишет defaults; service tier сохраняется.
Сохранённые и удалённые чаты не получают проектные defaults.

Название берётся из `local-conversation-title-signals` в локальной странице `on`.
Передаются resolved conversationId и исходный route id; cleanup сбрасывает имя.
Компонент облачного ChatGPT не изменяется. Прежний общий текст открывается с
уникальным адресом без Companion draft token, сохраняя общий native draft key.

379 тестов и живые A/B проверки приняты Main. Доказательства —
`.artifacts/update-024/`; состояние пакета/установки — `docs/HANDOFF.md`.
Разделы ниже описывают прежний слой 0.2.1–0.2.3.

## Список открытых чатов

src/openChatsModel.ts валидирует api1 snapshot существующего native bridge,
отбирает локальные записи, различает panelId, сортирует waiting/error/running/
idle/done со стабильным порядком. Title-only display/search, номер представления
при одинаковых заголовках. Равная sequence допустима (rename/open/close её не
меняют), меньшая sequence того же instance отбрасывается.

src/openChatsUi.ts — dependency-injected нативный QuickPick. Сериализованы все
getState, poll раз в секунду только при видимом списке. При обновлении остаются
query и active panel. Перед focusTab проверяются instance/panel/thread/route;
нет fallback openWith/reopen для устаревшей строки. Поздний focus отменяется
при disposal/смене запроса/потере compatibility gate.

src/extension.ts регистрирует openChats; editor/title navigation@3 и quota menu/
tooltip ссылаются на него. Позиции launch/history сохранены. Метаданные относятся
к текущему окну; per-tab cwd отсутствует, других клиентов не наблюдаем.

## Настоящий путь черновика Codex

Активный local composer — wKi → cNi; getInitialContent/getInitialInput читают
Gbe/BDe, onDocumentChange пишет aBe. Prompt store composer-prompt-drafts-v2
(legacy v1) и composer-retained-documents-v1 используют g_(scope)=Fv(scope).

scripts/officialDraftTransform.cjs принимает только точный workflow c014 и
оригинальный 7a. Один native span Fv(new/home/gptId==null) меняет:
`xp({entrypoint: home})` → `__companionDraftIsolation.scopeKey(xp(...))`.
Helper читает UUID из HOME initial-route, обрабатывает normal/whole escaped
query и сохраняет первоначальную identity вкладки. Другие виды composer и
нетокенизированный HOME возвращают прежний ключ. Saved/local/GPT/cloud/panel,
Tw/pit/fit/identity/model/effort/send остаются побайтно прежними.

resources/officialDraftIsolation.js добавлен prefix в оба webview modules:
это обеспечивает helper при циклических ESM imports до раннего вызова Fv.
Тело 7a после prefix полностью прежнее. Host/97d не меняются.

Первый yQn/Ynt/Xnt/Znt patch был соседним ChatGPT-путём, не исправлял local UI
и отвергнут. В релизе этих замен нет. Native schema и optimistic expectedValue
сохраняются, самостоятельного копирования/удаления legacy записей нет.

openLegacyDraft открывает официальный untokened HOME с постоянным recovery URI
в том же окне; старый общий текст доступен вручную. Модельные сообщения не шлёт.
В буферных изображениях изоляция live проверена; cold restart не восстанавливает
их ни до, ни после патча — собственная persistence изображений не добавлена.

## Квоты

quotaDisplay.ts — компактные два наиболее израсходованных server windows и +N,
fresh-only severity >=90 warning / >=100 error. Последний снимок после reset
остаётся с refresh-needed marker; stale/missing/future/invalid timestamps не
объявляются свежими. Date range проверяется. Логотип/woff сохранены.

quotaPresentation.ts/quotaUi.ts — used+remaining, все buckets/точные credits,
reset/lastUpdated/local UTC offset и approximate since-start pace (только fresh).
Tooltip appendText для server strings, доверенные commands узкие. Новая вкладка,
Open Chats, Refresh и report — нативные команды. quotaMonitor/parser/старый
formatQuotas не менялись; новых API вызовов и проектной атрибуции нет.

## Установщик

companionPatches.cjs читает pinned patchBundleManifest; schema1=4files/4stages,
schema2=5files/5stages, additive drafts. Пятый original7a SHA256:
59b909377a370e09cb8523ab99a1f4ff282a0126527bd339db31e6d9ac7c9c26.
Всего четыре writable bundles, package — guard, не переписывается.

Новый default backup old version dir/drafts-v1; original4 files/manifest старого
backup сохраняются. Проверенные old4 + текущий original7a автоматически собирают
новый полный source map5. Альтернатива — verified originalDir5. Invalid новый
backup не перекрывается. Bound extension path/identity/hashes/symlinks проверяются.

Генерация pure original map: history → titles → status/model → draft transform,
затем сравнение latest hashes. Нет runtime зависимости от developer fixtures.
Extension-wide + backup locks, повторный preflight под lock, atomic targets,
post-verify и rollback точных предыдущих байтов. Изменённые извне файлы при
rollback сохраняются, residual errors выводятся. Stale lock не перехватывается.

generatePatchBundleManifest.cjs — release only, generate schema2 / generateLegacy
schema1 из verified originals. Старые workflow hashes сохранены. Attestation2
порождается из verified latest stage; inspector поддерживает schema1/2, cache
учитывает все пять файлов. Хороший диск/ready bridge не доказывает загрузку
нового renderer в уже открытых окнах: после задач нужен ручной reload.

## Проверки и упаковка

332 tests pass, targeted report tests pass. Реальный VS Code: порядок DOM,
поиск, focus/close, квоты; A/B текст/new/cold, legacy recovery, saved/model/config,
live images и comparison cold-image baseline. Нулевые model messages.
Portable VSIX: legacy adoption, неизменный old backup, exact full5 restore,
reinstall/no-op. Артефакты — .artifacts/productivity-021.

VSIX содержит compiled runtime, canonical CJS transforms, compact manifests,
helpers, WAV/PS, notifier и woff. Originals/.artifacts/tests/docs/source TS
не входят. 0.2.0 VSIX/backups сохранены. Native patch installed; окончательная
установка Companion 0.2.1 подтверждена installed-final.json: 106 файлов
совпадают, package отличается только __metadata, compatibility ok, backup valid,
canRestore true. Публикации нет.

## Уточнение 0.2.2 — кредиты в status bar

`quotaDisplay.ts` добавляет creditsText после ranked windows/+N всегда, перед
freshness markers. Валидные finite decimal balances округляются Math.round;
ноль сохраняется, unlimited — ∞, invalid — ?, missing/null без unlimited скрыты.
Существующие имена/ограничение числа credit buckets сохранены, балансы не суммируются.
Tooltip/report и parser не менялись. Main: 336 tests pass и actual native VS Code
UI (synthetic quotas); пакет установлен, остальные runtime/native bytes прежние.
Доказательства — `.artifacts/credits-022/`.
