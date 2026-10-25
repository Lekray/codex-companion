# Контекст для продолжения

## CURRENT — 0.2.7, установлено 25 октября 2026

На «дальше» выполнен следующий пункт очереди: тихое восстановление статусов
после reload для OpenAI **26.1021.22027**. Companion **0.2.7** локально установлен.
Наблюдаются только существующие запросы/ответы `thread/read` официальной панели;
нового RPC/App Server, polling, resume и сообщений модели нет.

- Runtime active flags восстанавливают running/waiting, systemError — error.
  При includeTurns:true используются последние inProgress/completed/failed/
  interrupted turns. Незавершённая цель и известные вопросы не дают ложного [V].
- Не более 64 записей чтения; проверяются webview/thread, sequence, live epoch,
  id/время turn. Новые live-события и известные terminal выигрывают у устаревшего
  снимка. Отсутствующие/неполные данные не сбрасывают известное завершение.
- Hydration публикует live:false: название/счётчик обновляются без notice/sound.
  Последующие live-события уведомляют обычно. Ответы на вопросы сопоставляются
  по native-конверту и отдельным questionItemId, включая частичные ответы;
  непринятое steering и посторонний текст вопросы не закрывают.
- Граница: вопросы completed turn после reload и постраничная история не
  восстанавливаются надёжно. Без полного turns доступны только runtime flags;
  изображения и история квот остаются backlog. Другие клиенты не наблюдаются.
- Main: **426 passed, 0 failed/skipped** в tests-main-tracked.log; npm build
  пройден. Отслеживаемый набор исключает новый пустой тест соседней сессии;
  её officialWebviewRecovery файлы сохранены и в этот выпуск не входят.
- Main проверил реальные вкладки отдельного VS Code: running/waiting, счётчик,
  cold restart и тихую hydration, stale read после terminal, тихий повтор terminal
  и последующее live completion. Статусы синтетические, сообщений модели 0.
  В изолированную native-копию добавлены test hooks; отдельная тестовая копия
  Companion имеет attestation ровно этих изменений. Защита продукта не отключалась.
  В UI проверена диспетчеризация звука, физическое воспроизведение не повторялось;
  WAV прежние. Скриншоты просмотрены; native promo перекрывал composer, счётчик
  и заголовок были видимы. Ошибки font/offline совпали с прежним контролем 0.2.6.
- Из конечного VSIX пройдены exact5/exact9 restore/reinstall/no-op и обновление
  через точный restore engine 0.2.6. Он возвращает исходные файлы OpenAI, затем
  engine 0.2.7 устанавливает новый слой. Backup остаётся прежним и валидным.
- Установленные **114 файлов** совпадают с VSIX; package отличается только
  __metadata. Compatibility ok, backup valid, canRestore true. Из native только
  host изменил байты; webviews совпадают с прежними. После restore/install их
  mtime может измениться. **21 файл backup** сохранён по hash/mtime;
  legacy runtime/metadata 26.1007 побайтно прежние.

Evidence — .artifacts/status-restore-027/: accepted-source.json,
tests-main-tracked.log, ui/accepted-native-ui.json, ui/fixture-attestation.json,
ui/accepted-console.json, accepted-portable.json, package-inspection.json,
installed-native.json, installed-final.json. Неудачные попытки сохранены отдельно.
Main исправил основу Flash: epoch для двух одновременных reads, stale active
после terminal/перезапуска, цель, точные ответы/частичные вопросы и bounded scans.
Рабочие окна не закрывались и не reload. После всех задач пользователь делает
один ручной Developer: Reload Window. Публикации нет; этот этап завершён.

## Предыдущий этап — 0.2.6, установлено 25 октября 2026

На «делай» после предложения ближайшего выпуска реализованы, приняты Main и
локально установлены исправление «Истории проекта», навигация по ожиданиям и
отдельное уведомление ожидания. Исследованы статусы/изображения после reload;
их сохранение и история квот в этот выпуск не входят.

- `projectHistoryUi` и резервный `titleRefresh` допускают обе проверенные версии:
  26.1007.21434 и 26.1021.22027. Неизвестные версии по-прежнему отказываются.
- `codexCompanion.nextWaitingChat` перебирает ожидающие панели;
  `codexCompanion.nextAttentionChat` — ожидания, затем ошибки. Можно назначить
  клавиши, привязок по умолчанию нет. `[? N]` скрыт при нуле, клик — к следующему
  ожиданию. Текущее окно, только метаданные, без нового App Server/опроса чатов.
- Перед фокусом две сверки instance/panel/thread/route/status. Закрытые панели
  не переоткрываются. Сверка после tab events отложена на 100 мс: Main на живом
  UI поймал порядок «закрытие вкладки → позднее удаление native-панели» и добавил
  регрессию/отмену таймера при disposal. Постоянного опроса нет.
- Live idle → waiting тоже уведомляет «нужен ваш ответ» / `needs your answer`.
  Отдельный `waiting.wav` 0.32 с; completion.wav побайтно прежний. Общие настройки
  уведомлений/Windows/звука сохранены, mute глушит оба сигнала. Логический eventId
  дедуплицирует уведомления; отдельного сигнала на каждый вопрос одного turn
  не гарантируется. Счётчик получает свежие события до этой дедупликации:
  повторный running после ответа не оставляет старое ожидание.
- Main: **410 passed, 0 failed/skipped**. В настоящем VS Code проверены история
  проекта на 26.1021, три реальные панели, счётчик/циклы/ответ/закрытие без reopen,
  waiting/done уведомления, реальный клик «Открыть» и точный native focus, тишина
  дублей и повторный running. Статусы синтетические, сообщений модели 0.
  В UI перехвачена только диспетчеризация звуков; оба WAV отдельно воспроизведены
  штатным PowerShell SoundPlayer. Слышимость человеком отдельно не подтверждалась.
- Контрольный B-профиль без подмены статусов воспроизвёл native data-font CSP и
  ошибки блокированной сети. Эти точные сигнатуры сохранены отдельно; новых
  фатальных ошибок UI нет. Во время теста native model promo мог перекрывать
  composer; проверялись видимые status bar/toasts/вкладки и фактический focus.
- Из конечного VSIX пройдены exact5/exact9 restore/reinstall/no-op и guarded
  переход через точный restore прежним engine. Companion **0.2.6** установлен,
  **114 файлов** совпадают с VSIX, package отличается только `__metadata`.
  Native source/runtime/manifest/attestation не менялись; 30 файлов установленного
  OpenAI и текущего/старых backup сохранены по hash/mtime. Compatibility ok,
  backup valid, canRestore true. Рабочие окна не закрывались и не reload.

Evidence: `.artifacts/attention-026/{accepted-source,accepted-sound,
accepted-portable,installed-final,package-inspection}.json`, `tests-main.log`,
`ui/accepted-attention-ui.json`, `ui/console-control.json`, screenshots.
DeepSeek Flash реализовал основу и документы/скрипты; Main исправил hook dedup,
возврат promise, tab-disposal race и тестовый harness (hydration, dirty document,
Windows module identity). Неудачные тестовые попытки сохранены отдельно.

Следующий этап на момент 0.2.6 (реализовано частично в 0.2.7): восстановление статусов через thread/read требует
отдельного guarded native patch и проверки stale/terminal, включая вопросы после
completed turn. Изображения живут в памяти отдельно от текста — нужен отдельный
native target, формат хранения, лимиты и очистка. История квот — account-wide,
с границами reset/аккаунта, без оценок по проектам. `research-review.json` уточняет
границы первоначального исследовательского отчёта.
После завершения задач пользователь выполняет один ручной `Developer: Reload Window`.
Публикации нет; обязательных задач ближайшего выпуска не осталось.

## Предыдущий этап — 0.2.5, установлено 25 октября 2026

Исправлен пропущенный `[?]` на карточках с вариантами ответа в установленном
OpenAI **26.1021.22027**. Асинхронные вопросы приходят как
`item/started|item/completed` с `agentMessage.questions`, а прежний обработчик
учитывал только синхронные server requests/active flags. Отдельно Main
воспроизвёл сброс `[?]` событием active с пустыми flags при открытом sync request.

- `resources/officialTabStatusV2.js` обрабатывает карточки, дедуплицирует их по
  turn/item, удерживает waiting при active/idle и успешном terminal без `[V]`
  и звука до ответа/нового turn. Ошибки и прерывания очищают ожидание; поздние
  items старого turn не возвращают карточку. В память не пишутся тексты/варианты.
  Main сохранил активность turn на промежуточном idle до настоящего terminal.
- Adapter `scripts/official261021.cjs` использует новый runtime. В native меняется
  только этот status core внутри `out/extension.js`; Main доказал точную замену
  старого core новым, остальные слои и webview файлы побайтно прежние.
- `officialTabStatus.js`, legacy manifest/attestation и весь слой 26.1007.21434
  сохранены побайтно. Исправление карточек в старую версию не переносилось:
  общий runtime нарушал обязательную совместимость с old4 legacy adoption.
- Полный прогон Main — **387 passed, 0 failed/skipped**. Тесты используют
  реальные типы protocol payload, проверяют waiting/ответ/новый turn/ошибку,
  дубликаты, отсутствие ложного done, sync pending и обычное завершение.
- Конечный VSIX прошёл exact5/exact9 restore/install/no-op и guarded upgrade
  через точный restore прежним engine. Native установлен из принятого пакета,
  затем Companion `.artifacts/codex-companion-0.2.5.vsix`; **112 файлов** совпадают
  с VSIX, package отличается только `__metadata`. Compatibility ok, backup valid,
  canRestore true. Текущий chunks-v1 и оба старых backup 26.1007 сохранены по
  hash/mtime. Каталог старой установленной OpenAI 26.1007 при финальной проверке
  отсутствует; его наличие в начале этой сессии не фиксировалось.

Evidence: `.artifacts/question-status/{accepted-source,accepted-portable,
installed-native,installed-final}.json`, `tests-main.log`. DeepSeek Flash нашёл
пропущенный путь и реализовал основу; Main исправил idle/protocol fixtures и
выделил version-specific runtime после полного прогона.

25 октября пользователь попросил живую проверку. В рабочей вкладке открыли
настоящую карточку `request_user_input_async`; пользователь выбрал
«[?] — ожидание ответа». Появление `[?]` подтверждено в реальном UI.
Переход после ответа и звук в этой проверке отдельно не подтверждались.
Автоматизированные проверки статусов синтетические, отдельных запросов генерации
для них не отправляли. При reload running/waiting по-прежнему восстанавливаются как
idle до новых native событий; восстановление открытых карточек не добавлено.
Рабочие окна не закрывались и не reload. После задач пользователь выполняет
один ручной `Developer: Reload Window`. Публикации нет; обязательных задач нет.

## Предыдущий этап — 0.2.4, установлено 24 октября 2026

Companion 0.2.4 поддерживает две версии: официальные OpenAI **26.1007.21434**
(прежний слой без изменений) и **26.1021.22027** (новый adapter). Код, живые
сценарии и пакет приняты Main; Companion и дополнения OpenAI установлены.

- Старые helpers/transforms и legacy manifest/attestation не меняются. Новый
  version-pinned adapter — `scripts/official261021.cjs`; общая guarded factory —
  `scripts/companionPatchEngine.cjs`; публичный facade
  `scripts/companionPatches.cjs` выбирает точную установленную identity.
- 26.1007.21434: прежние schema 1/2, пять файлов и backup
  `%LOCALAPPDATA%/codex-companion/patches/26.1007.21434/drafts-v1` сохранены.
- 26.1021.22027: schema 3, девять оригиналов — package.json (identity guard),
  out/extension.js и семь точных webview chunks: src-622b307a9baf,
  initialize-app-host-services.extension-f722db488e05,
  local-conversation-page-e49199d4fdb5, message-bus-4113ba7287d7,
  use-model-settings-aafcff4b111c, composer-content-8ab21f1a1982,
  composer-scope-f0dbf0e746b6. Metadata —
  `resources/patchBundleManifest-26.1021.22027.json` и
  `resources/patchAttestation-26.1021.22027.json`; backup —
  `%LOCALAPPDATA%/codex-companion/patches/26.1021.22027/chunks-v1`.
  Full restore возвращает все оригинальные цели; package identity не
  переписывается. Новый install не делает legacy adoption и не трогает старый
  backup.
- Слои прежние: history/startup/titles/model/status/notifications/drafts;
  product scope, ограничения и quota UI 0.2.3 не меняются. UUID HOME text draft
  scoping в новом билде — chunk `composer-scope`; `Fv`/`7a` относятся только к
  26.1007. Native `homeDraftKey` locking, saved chats/models/send остаются
  штатными.
- Unknown/modified/mixed по-прежнему отказываются; locks, atomic,
  all-before-write, stable-state и rollback сохранены. Стандартные команды и CLI
  прежние. Adapter принимается только после live-проверок и точного rollback Main.
- Новых возможностей и провайдеров нет; публикация не разрешена. Пакет
  `.artifacts/codex-companion-0.2.4.vsix` установлен; evidence —
  `.artifacts/update-024/`. Рабочие окна не reload: после задач один ручной
  `Developer: Reload Window`.

### Приёмка Main

379 тестов без ошибок/пропусков — `final-tests.log`. Приняты UI evidence:
`ui-scripts/accepted-drafts.json`, `accepted-models.json`, `accepted-tabs-history.json`,
`accepted-bridge.json`; изображения — `accepted-images.json`. Два синтетических
проекта с обеими историями в каждом home, fake auth/blackhole, сообщений модели 0.
A — 6.1 Sol/Medium, B — 6 Astra/High; новые вкладки и restart, сохранённый чат
5.6 Luna/High, config unchanged. Rename A/B и restart, recent/full/search A/B,
QuickPick search/exact focus, A/B drafts/legacy/restart и вложения switch пройдены.
Статусы проверены автоматическими тестами и live bridge capability/idle metadata;
реальных запросов генерации для проверки статусов не отправляли.

Main исправил первоначальный model port: ленивый renderer payload, перехват
нативного setter, корректные promises/повторные эффекты, native HOME optimistic
atom без записи defaults, допуск managed draft при отсутствии policy lock.
Title port перенесён с ошибочно выбранной облачной страницы на локальную страницу
и штатный local title signal; добавлены 12 поведенческих тестов. Старые слои и
ресурсы 26.1007 сохранены. UI harness дожидается готовности восстановленных
вкладок до закрытия и native draft debounce; служебные тосты скрывает перед
кликом picker. Сбои старых прогонов в evidence не являются текущими дефектами.

Из распакованного конечного VSIX пройдены установка без developer fixtures,
точный возврат всех 9 оригиналов, повторные no-op restore/install и reinstall —
`accepted-portable.json`. Установлено из этого VSIX: 111 файлов совпадают
побайтно, package.json отличается только __metadata VS Code. Native состояние
drafts, все 7 возможностей installed, compatibility ok, backup valid/canRestore
true — `installed-final.json`. Исходный package OpenAI не переписывался.
16 прежних файлов установки/backup 26.1007 не изменены по SHA256 и mtime.
Картинки из буфера независимы при переключении; после cold restart отсутствуют
в обоих тестовых чатах и в 26.1021 (`images-after-restart.json`) — прежнее
ограничение сохраняется. Рабочие окна не закрывались и не reload; пользователь
выполняет один ручной Developer: Reload Window после задач. Публикации нет.
Обязательных задач этого обновления не осталось.

## Предыдущий этап — 0.2.3, 20 октября 2026

Исправления по ревью кредитов на кнопке: общая функция `roundedCreditBalance`
(formatQuotas.ts) для кнопки и `quotaText`; ненулевой остаток, округляемый в 0,
показывается `<1`/`>-1`; половины округляются от нуля; непарсящаяся строка сервера
показывается как есть (до 10 символов с …), `?` только для пустой/отсутствующей;
значения больше 2^53 — исходной строкой. Кредиты упорядочены по самому загруженному
показанному окну их счёта, скрытые — `$(credit-card) +N`; имя счёта в кредитах ≤10.
Цвет предупреждения от нулевого баланса сознательно не добавлен (у тарифов без
кредитов сервер шлёт 0). 337 тестов; установлен из VSIX, 106 файлов совпадают,
OpenAI-файлы не менялись, backup valid, compatibility ok —
`.artifacts/credits-023/`. Реальный UI на синтетических квотах для 0.2.3 не
перепроверялся (изменён только текст кнопки, покрыт тестами). Нужен ручной reload.

## Предыдущий этап — 0.2.2, 18 октября 2026

Кредиты в нижней кнопке показываются после лимитов и `+N`, перед маркерами
свежести; баланс округляется до целого только в status bar, tooltip/report
сохраняют точную строку сервера. Парсер, API, OpenAI-слои и логотип не менялись.
0.2.1 принята пользователем после ручного reload. Main принял правку Flash:
336 тестов без ошибок/пропусков, реальный VS Code с синтетическими квотами —
43 рядом с лимитами, точные 42.500 в tooltip/report, ноль/безлимит/stale/missing.
Тестовое окно закрыто штатно, модельных сообщений 0. Companion 0.2.2 установлен;
106 файлов совпадают с VSIX, package отличается только __metadata, compatibility
ok, backup valid/canRestore true. Пять установленных файлов OpenAI не менялись.
Evidence — `.artifacts/credits-022/{tests.log,accepted-ui.json,accepted-package.json,installed-final.json}`.
Рабочие окна не reload; после задач нужен один ручной Developer: Reload Window.
0.2.1 VSIX сохранён для возврата; публикации нет. Обязательных задач нет.

## Предыдущий этап — 0.2.1, 18 октября 2026

Все три направления пользователя «делай всё» реализованы и приняты Main:
список открытых чатов, раздельные текстовые черновики, улучшение квот.
Новый нативный слой установлен в OpenAI 26.1007.21434; Companion 0.2.1
установлен из окончательного VSIX. Main проверил 106 файлов побайтно; package.json
отличается только служебными __metadata VS Code. Совместимость ok, backup5 valid,
canRestore true (installed-final.json). Рабочие окна не закрывались и не reload;
публикации нет.

### Принятый результат

- `src/openChatsModel.ts` / `openChatsUi.ts`: нативный QuickPick текущего окна,
  поиск, waiting/error первыми, номера представлений, пустые вкладки,
  обновление без сброса запроса, равная sequence допускает rename/open/close.
  Перед фокусом проверяются instance/panel/thread/route. Закрытая панель не
  переоткрывается. Отложенный фокус отменяется при disposal/потере совместимости.
  Опрос 1 с только при открытом меню. Команда `codexCompanion.openChats`,
  кнопка editor/title navigation@3; запуск и история на прежних местах.
- `src/quotaDisplay.ts`: два самых израсходованных серверных окна и +N;
  все значения в tooltip/report, использование/остаток, точные кредиты,
  даты с UTC offset, свежесть, refresh после сброса без выдуманного нуля.
  90/100% выделяются только для свежих данных. Прежний approximate pace
  since-window-start сохранён. Логотип в status bar и woff сохранены.
- `scripts/officialDraftTransform.cjs` / `resources/officialDraftIsolation.js`:
  одна ветка Fv(new/home/gptId==null) оборачивает native xp key в scopeKey.
  UUID берётся из initial-route HOME (обычный/escaped query). Это ключ
  ComposerScope и native composer-prompt-drafts-v2 / retained-documents-v1.
  В обоих bundles есть bootstrap helper; тело 7a после prefix побайтно прежнее.
  Все остальные ветки Fv и Ynt/Xnt/Znt/coerce/Tw/pit/fit, yQn, модель,
  effort, IDs и send protocol не менялись. Старые accepted transforms сохранены.
- Прежний общий текст доступен через `codexCompanion.openLegacyDraft`:
  официальный HOME editor с нетокенизированным ключом; не отправляет сообщения.
- Текст A/B: новые поля пусты, переключение и cold restart сохраняют каждый
  собственный текст. Сохранённый чат и его модель/черновик остаются прежними;
  новый чат после restart получает проектную пару 6.1 Sol / Medium.
  config.toml не изменён. Картинки из буфера изолированы при переключении,
  но cold restart их не восстанавливает; проверено также на исходном workflow.

### Установка и откат

Manifest/attestation schema2, пять файлов, стадии original/history/titles/workflow/drafts.
Пятый файл — webview/assets/app-initial-7a199c66e670.js, original SHA256
59b909377a370e09cb8523ab99a1f4ff282a0126527bd339db31e6d9ac7c9c26.
Drafts меняет c014 и добавляет bootstrap в 7a. Host/97d прежние; package не пишется.

`scripts/companionPatches.cjs` — check/install/restore; опции --extension,
--backup, --original-dir, --legacy-backup. Новый default backup:
`%LOCALAPPDATA%/codex-companion/patches/26.1007.21434/drafts-v1`.
Старый родительский 4-file backup и manifest побайтно/по mtime сохранены.
На живой установке auto legacy adoption прошёл: verified old4 + original7a →
новый полный backup5, состояние drafts, canRestore true (`installed-official.json`).

Двойные locks (extension и backup), exact version/hash/path binding, symlink
проверки, all-before-write, atomic writes и rollback сохраняются. Внешние байты
при rollback не перезаписываются. Unknown/mixed/modified/corrupt backup отказываются
до записи. Stale lock требует ручной проверки, автоматического перехвата нет.
Full restore возвращает все 5 оригиналов; пользовательские данные не удаляются.
Перед downgrade на 0.2.0 нужен full restore новым engine, затем старый VSIX/patches.
Старые legacy CLI остаются, но не умеют стадию drafts.

### Доказательства Main

Каталог `.artifacts/productivity-021/`:

- final-tests.log: 332 passed, 0 failed/skipped; дополнительные report tests pass.
- accepted-ui.json: фактический DOM порядок (не alphabetical), поиск, focus,
  live close, recovery command, logo/compact quota/tooltip/report. Метаданные
  статусов/квоты синтетические; без запросов генерации.
- draft-observations.json: исходная коллизия. draft-corrected-observations.json:
  все три independentOnOpen/Switch/Restart true.
- accepted-drafts-controls.json: legacy общий текст сохранён, saved draft/model,
  project pair после restart, config unchanged, изображения изолированы live.
- accepted-native-image-baseline.json: прежний workflow тоже не восстанавливает
  изображения из буфера после restart.
- accepted-materials.json: старые workflow hashes сохранены; latest получен из
  проверенных originals и canonical transforms, не из произвольной установки.
- accepted-portable.json / accepted-installer.json: VSIX runtime без fixtures,
  legacy adoption, старый backup сохранён, exact 5-file restore и reinstall/no-op.
- installed-official.json: живой native patch, backup valid; package/source host/97d
  не менялись. accepted-package.json: runtime совпадает с принятой portable
  сборкой; installed-final.json: Companion 0.2.1 установлен и проверен,
  compatibility ok, backup valid, старые originals/hash/mtime не изменены.

Все тестовые Code.exe закрыты штатно. Модельных сообщений 0. Публикации нет.
Новые команды/renderer загружаются при одном ручном Developer: Reload Window
после завершения задач; агент рабочие окна не reload.

### Ограничения и продолжение

Список — панели текущего окна; строгого cwd per-thread фильтра здесь нет.
Облачная история и штатный VS Code session picker не фильтруются. Другие клиенты
не мониторятся. Реальная генерация/реальные данные квот аккаунта не тестировались.
Изображения из буфера не восстанавливаются после cold restart (старое поведение).

Первый Flash draft-вариант (yQn/identity) не прошёл реальный UI и отвергнут.
Pro ro связал активный wKi/cNi composer с Fv; итоговый patch узкий и принят
по live proof. Подробности исполнителей и старый журнал — в MAIN_HANDOFF.txt
и ds review records, не повторять их как текущие задачи.

0.2.0/dev.15 VSIX и backups сохранены. Историческая приёмка звука [V] и native
Windows click пользователем остаётся действующей; новые status/model helpers
побайтно прежние. Этап 0.2.1 завершён; обязательных задач не осталось.
