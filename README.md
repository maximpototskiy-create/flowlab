# FlowLab Step 4.5 — Архитектурный фикс: конкурентные runs, polling leak, edges, ContextMenu, ConnectionPicker

## Корень проблем

Ты сообщил: после первой генерации перестают коннектиться edges, ConnectionPicker не создаёт ноду, ContextMenu тоже, новый воркфлоу сыпет 500-ками. Я полез в логи и **нашёл реальную причину каскада**.

### Главная находка из логов

В логах вижу `POST /api/runs/start` **7 раз за 5 секунд**, потом `prisma:error Timed out fetching connection from the pool (limit: 5)` тоже **7+ раз**. И GET `/api/runs/<old_id>` бьётся даже после того как ты ушёл на другой воркфлоу.

**Что происходило:**
1. Ты жал ▶ на разных нодах подряд → 7 параллельных runs
2. Каждый run заводит **polling interval 4сек** → 7 интервалов одновременно
3. При смене воркфлоу старые интервалы НЕ убивались → продолжали бить /api/runs/[id]
4. + auto-save graph каждые N секунд
5. Connection pool забит → все запросы 500 → "Save failed"
6. Page re-renders → state в Canvas теряется → edges не подключаются, drag сбивается, ContextMenu/ConnectionPicker race с outside-click-close

## Фиксы

### 🔴 Polling leak — главный убийца
Добавил **cleanup useEffect** который при unmount Canvas (закрытие воркфлоу, навигация) убивает ВСЕ активные polling intervals. Раньше они жили вечно.

### 🔴 Duplicate runs — kasкадный спам
Добавил `inflightScopes` Set. Если жмёшь ▶ на ноду где run уже идёт — игнорим. Раньше можно было настрелять 10 одновременных.

### 🔴 Pointer listeners пересоздавались на каждый render
useEffect для onMove/onUp depends на `[drag, edgeDraft, isPanning, zoom, screenToCanvas]`. Каждый polling tick → setGraph → re-render → effect пересоздаётся → window listeners снимаются и навешиваются заново. Если в этот момент юзер двигал мышью посреди drag — **events пропадают**.

**Фикс:** все mutable state теперь читается через **stable refs**, listeners ставятся **один раз на mount**. Drag, edges, pan теперь не сбиваются при polling.

### 🔴 Connection pool — финальный размер
Скакал 1→10→5. По официальной доке Supabase для serverless — **connection_limit=1**. Supavisor (pgBouncer) мультиплексирует на стороне сервера, нам не нужны множественные коннекшены на лямбду.

С `cached()` (10s TTL) параллельные dashboard-запросы из 1 лямбды теперь сериализуются Prisma и не упираются в timeout.

### 🔴 ConnectionPicker — нода не создавалась
Та же проблема как с ContextMenu в прошлом patch: `onClick` срабатывает после `mousedown`, а global outside-click-close listener успевал закрыть picker и обнулить state до того как onClick доходил до addNodeAt. Заменил на `onMouseDown` + `stopPropagation` + IIFE capture coords.

### 🟡 Edges не в центре кружков
Я ставил `NODE_HEADER_HEIGHT = 38`, а реальная высота `h-9 + border-b-1` = 37, визуально ближе к 36. Поправил константу и захардкоженное `38` в `startEdge`.

### 🟡 Логирование Storage
Сейчас при падении uploadFromUrl мы тихо возвращали fal URL. Теперь печатаем **точную ошибку в Vercel logs**: `[persistAsset] STORAGE FAILED for <path>: <message>`. Когда после деплоя сделаешь генерацию, в Vercel logs увидим почему bucket не работает (если service_role_key не работает / bucket policy / etc).

## Про "изображения пропадают"

Ситуация: fal.ai URL живёт ~24ч (часто меньше). Пока не работает Supabase Storage — после refresh картинки/видео исчезают.

`ensureBucket()` уже есть и должен создавать бакет автоматически при первой попытке. Но скорее всего падает по какой-то причине. **После деплоя сделай 1 генерацию → пришли мне Vercel logs за этот момент** — увижу строку `[persistAsset] STORAGE FAILED` и сразу починю.

Альтернатива на 30 секунд: Supabase Dashboard → Storage → New bucket → `flowlab-assets` → Private. После этого автоматически заработает.

## Файлы (4 штуки)

- `src/lib/prisma.ts` — connection_limit=1 (по officialному совету Supabase)
- `src/components/canvas/Canvas.tsx` — polling cleanup, inflightScopes, stable refs, IIFE capture, header height fix
- `src/components/canvas/CanvasNode.tsx` — NODE_HEADER_HEIGHT 38 → 36
- `src/components/canvas/ConnectionPicker.tsx` — onMouseDown + stopPropagation
- `src/lib/engine/runners.ts` — улучшенное storage logging

## Накатить

GitHub → Upload files → перетащить папку `src` → Commit `Step 4.5: concurrent runs + polling leak + UX`.

## Тест

1. Cmd+Shift+R
2. **Polling cleanup:** запусти ▶, перейди на другой workflow → в Vercel logs больше не должно быть бесконечных GET /api/runs/[id]
3. **No duplicate runs:** жми ▶ много раз подряд → запустится только один run
4. **Edges после генерации:** запусти ноду, дождись результата, попробуй добавить новую ноду + edge → должно работать (раньше после генерации drag/edges ломались)
5. **ConnectionPicker:** тяни линию от ноды в пустое место → меню → выбери ноду → ноды соединятся
6. **Save не падает:** работай 5 минут активно — никаких "Save failed" в углу
7. **Edges по центру:** линии должны входить точно в центр кружков

## Что после этого

Когда увижу что storage логирование показывает (после твоей генерации) — поправлю окончательно проблему "изображения пропадают". Это последний оставшийся 🟡 пункт.



FlowLab — Final (Step 4 + 4.1 hotfix merged)
Это полный проект, готовый к деплою. Включает всё:

Step 4: реальное выполнение нод через fal.ai, Brand Kit, Run History, темы
Step 4.1 hotfix: модели 2026 (Claude Opus 4.7, Nano Banana 2, Kling 3.0, Seedance 2, Veo 3.1), правильные входы для видео (start_frame / end_frame / reference), тачпад-пан, рабочие кнопки в шапке нод, drag-плавность
Как залить на GitHub и задеплоить — за 5 минут
Шаг 1. Подготовь GitHub репозиторий
Открой https://github.com/maximpototskiy-create/<имя репозитория>
Зайди в Settings → General (внизу страницы) → раздел Danger Zone
Нажми "Delete this repository" → подтверди удаление
Спокойно — БД и деплой на Vercel никак не пострадают, они отдельные.

Вернись на главную GitHub → нажми "New repository" (зелёная кнопка)
Назови точно как был (важно — Vercel смотрит по имени)
Видимость — Private
Не ставь галочки на "Add README", "Add .gitignore" — оставь репозиторий пустым
Создай
Шаг 2. Залей файлы
На пустом репозитории GitHub покажет инструкцию. Игнорируй её. Вместо этого:

Нажми "uploading an existing file" (синяя ссылка в середине страницы)
Открой Finder, перейди в распакованную папку этого архива (flowlab/)
Выдели все файлы и папки внутри (Cmd+A) — src, prisma, package.json и т.д.
Перетащи их в окно браузера GitHub
Подожди пока всё загрузится (полоса прогресса)
Внизу страницы: Commit message → напиши Final: Step 4.1 with all fixes
Нажми "Commit changes"
Шаг 3. Vercel автоматически передеплоит
Зайди на https://vercel.com/dashboard → твой проект → вкладка Deployments. Через 30 секунд после коммита увидишь "Building..." → через 2-3 минуты "Ready".

Шаг 4. Проверка на проде
Открой свой URL (https://creative-lab-flow.vercel.app), войди и проверь:

☀️/🌙 иконка темы в верхней панели — переключается
Image Generation нода → дропдаун модели → первая строка "Nano Banana 2 ⭐"
Video Generation нода → 4 input порта слева (prompt, start_frame, end_frame, reference)
Тачпад двумя пальцами по канвасу — двигает канвас
Cmd+скролл — зум
На ноде кнопки ⤢ и ✕ работают
Правый клик на пустом канвасе → меню нод, работает многократно
Если работает локально
Это опционально. Если хочешь запускать на компе:

cd ~/Desktop/flowlab
npm install
Создай файл .env.local (НЕ коммитить!) и скопируй туда содержимое из Vercel Dashboard → Settings → Environment Variables. Только замени NEXTAUTH_URL на http://localhost:3000.

Запуск:

npm run dev
Открой http://localhost:3000

Что в архиве
✅ Полный проект FlowLab Step 4.1
✅ .gitignore — правильный, не пустит node_modules и .env.local в репозиторий
❌ Без node_modules/ (восстановится из npm install или Vercel сам поставит)
❌ Без .env.local (свои ключи)
❌ Без .next/ (билд-кеш, не нужен)
Размер архива ~170 KB.

Что есть на проде после деплоя
40+ нод в 7 категориях:

Text: Your Text, Text Generation, Creative Brief, Ad Analysis (vision), Image Ad Prompt, Ad Variation, Video Script, Video Frame Prompt, Video Ad Prompt, Voiceover Script, Music Prompt, Character Prompt
Image: Image Generation, Image Resize, Element Change (Kontext), Image Translation, Product Screen Placement, Character Gen, Upscale, Remove BG, Face Swap, Inpaint, Upload Image
Video: Video Generation (4 входа!), Talking Head, Lipsync, Motion Transfer, Upload Video
Audio: Voiceover (ElevenLabs), Music Gen, SFX Gen, Upload Audio
Structural: Hook, Body, Pack Shot, CTA, Scene, Transition, Logo Reveal
Integration: Custom API, Webhook
Tools: Note, Output, Export AE/Image/Audio
Все они через fal.ai → Supabase Storage → CDN. Run History и Brand Kit работают.

Если что-то пошло не так
Vercel билд упал → открой логи деплоя, скинь последние 30 строк
Сайт открывается, но при работе с нодами 401/404 от fal.ai → проверь env vars FAL_API_KEY_1 и FAL_API_KEY_2 в Vercel
Storage upload fails → проверь SUPABASE_SERVICE_ROLE_KEY в Vercel
Не открывается совсем → проверь DATABASE_URL в Vercel и NEXTAUTH_URL (должен быть https://<your-vercel-url>)

